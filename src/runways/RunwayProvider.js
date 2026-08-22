'use strict';

/**
 * Runway geometry provider.
 *
 * GCA guidance is only as good as the runway it is measured against, so the
 * thresholds are taken from DCS itself instead of being hand-typed: DCSServerBot's
 * RestAPI exposes `Airbase.getRunways()` (centre position in DCS metres, course in
 * radians, length, width) which is exactly the frame the ACMI stream's native
 * u/v coordinates live in.
 *
 *   GET {base}{prefix}/servers                              -> theatre of each server
 *   GET {base}{prefix}/airbases?server_name=...             -> airbase list (cheap, cached by the bot)
 *   GET {base}{prefix}/airbase?server_name=&airbase_name=   -> runways (runs Lua in the sim thread)
 *
 * The per-airbase call is the expensive one — it round-trips into the mission
 * thread — so the sweep is spaced out, run once per theatre and cached on disk.
 * Terrain does not move, so a cached theatre is reused by every server and every
 * mission from then on.
 */

const fs = require('fs');
const path = require('path');

const M_PER_NM = 1852;
const M_PER_FT = 0.3048;
const EARTH_M_PER_DEG = 111320;

// One global queue: three sources changing mission at once must not fire three
// concurrent airbase sweeps into the same sim.
let queue = Promise.resolve();

class RunwayProvider {
  constructor(cfg, source) {
    this.cfg = cfg;
    this.source = source;
    this.staticRunways = normaliseStatic(source.runways || [], source.glidepathDeg);
    this.runways = this.staticRunways.slice();
    this.theatre = null;
    this.state = this.staticRunways.length ? 'static' : 'empty';
    this.lastError = null;
    this.weather = null; // ground wind, for picking the into-wind runway
  }

  get status() {
    return {
      state: this.state,
      theatre: this.theatre,
      count: this.runways.length,
      error: this.lastError,
      wind: this.weather,
    };
  }

  cacheFile(theatre) {
    return path.join(this.cfg.cacheDir, `runways_${theatre.replace(/[^\w.-]+/g, '_')}.json`);
  }

  /** Refresh runway data for whatever mission the server is running now. */
  async refresh() {
    // Start-up and the first mission event fire within seconds of each other;
    // without this guard both would sweep every airbase of the same theatre.
    if (!this.pendingRefresh) {
      this.pendingRefresh = this.doRefresh().finally(() => {
        this.pendingRefresh = null;
      });
    }
    return this.pendingRefresh;
  }

  async doRefresh() {
    const d = this.cfg.dcssb;
    if (!d.enabled || !d.baseUrl || !this.source.dcssbServerName) return this.runways;

    try {
      const { theatre, status } = await this.fetchMissionInfo();
      if (!theatre) throw new Error('server not found in /servers or no mission loaded');
      if (theatre === this.theatre && this.state === 'dcssb') return this.runways;

      const cached = this.readCache(theatre);
      if (cached) {
        this.adopt(cached, theatre, 'dcssb');
        console.log(`[${this.source.id}] runways: ${cached.length} from cache (${theatre})`);
        return this.runways;
      }

      // Sweeping means asking the running sim about every airbase, so it only
      // works while the server is actually up. A shut-down server keeps whatever
      // it had and retries when its Tacview stream comes back with a mission.
      if (!['Running', 'Paused'].includes(status)) {
        throw new Error(`server is ${status || 'unknown'}, no cached data for ${theatre} yet`);
      }

      this.state = 'loading';
      const runways = await enqueue(() => this.sweep(theatre));
      if (runways.length === 0) throw new Error('no runways returned');
      this.writeCache(theatre, runways);
      this.adopt(runways, theatre, 'dcssb');
      console.log(`[${this.source.id}] runways: ${runways.length} from DCS (${theatre})`);
    } catch (err) {
      this.lastError = err.message;
      this.state = this.staticRunways.length ? 'static' : 'error';
      console.error(`[${this.source.id}] runway refresh failed: ${err.message}`);
    }
    return this.runways;
  }

  adopt(runways, theatre, state) {
    // Static entries win on id collision: they are the operator's explicit override.
    const staticIds = new Set(this.staticRunways.map((r) => r.id));
    this.runways = this.staticRunways.concat(runways.filter((r) => !staticIds.has(r.id)));
    this.theatre = theatre;
    this.state = state;
    this.lastError = null;
  }

  find(id) {
    return this.runways.find((r) => r.id === id) || null;
  }

  async fetchMissionInfo() {
    const servers = await this.api('/servers');
    const list = Array.isArray(servers) ? servers : servers.servers || [];
    const me = list.find((s) => s.name === this.source.dcssbServerName);
    if (!me) return { theatre: null, status: null };
    if (me.weather) {
      // DCS reports the direction the wind blows *towards*; DCSServerBot passes
      // it through unchanged (core/utils/dcs.py adds the 180 itself).
      this.weather = {
        windSpeedMs: me.weather.wind_speed,
        windFromDeg: me.weather.wind_direction === null ? null : (me.weather.wind_direction + 180) % 360,
      };
    }
    return { theatre: me.mission ? me.mission.theatre : null, status: me.status };
  }

  async sweep(theatre) {
    const server = this.source.dcssbServerName;
    const list = await this.api('/airbases', { server_name: server });
    const airbases = (list.airbases || []).filter((a) => Array.isArray(a.runwayList) && a.runwayList.length);
    console.log(`[${this.source.id}] sweeping ${airbases.length} airbases on ${theatre} (~${Math.round((airbases.length * this.cfg.dcssb.requestSpacingMs) / 1000)}s)`);

    const out = [];
    for (const ab of airbases) {
      try {
        const res = await this.api('/airbase', { server_name: server, airbase_name: ab.name });
        const info = res.airbase || {};
        out.push(...buildRunways(ab, info, this.source.glidepathDeg));
      } catch (err) {
        console.warn(`[${this.source.id}] airbase ${ab.name}: ${err.message}`);
      }
      await sleep(this.cfg.dcssb.requestSpacingMs);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async api(endpoint, params) {
    const d = this.cfg.dcssb;
    const url = new URL(d.baseUrl.replace(/\/$/, '') + d.prefix + endpoint);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), d.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: d.apiKey ? { 'x-api-key': d.apiKey } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  readCache(theatre) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(theatre), 'utf8'));
      if (Array.isArray(raw.runways) && raw.runways.length) return raw.runways;
    } catch {
      /* no cache yet */
    }
    return null;
  }

  writeCache(theatre, runways) {
    try {
      fs.mkdirSync(this.cfg.cacheDir, { recursive: true });
      fs.writeFileSync(
        this.cacheFile(theatre),
        JSON.stringify({ theatre, fetchedAt: new Date().toISOString(), runways }, null, 1)
      );
    } catch (err) {
      console.warn(`[${this.source.id}] runway cache write failed: ${err.message}`);
    }
  }
}

/**
 * DCS gives one entry per *physical* runway (centre + course + length); a GCA
 * console needs one entry per *landing direction*, so the reciprocal end is
 * synthesised from the same strip.
 */
function buildRunways(airbase, info, glidepathDeg) {
  const out = [];
  const runways = info.runways || [];
  const seen = new Set();

  for (const rw of runways) {
    if (!rw || !rw.position || typeof rw.course !== 'number') continue;
    const headingDeg = normDeg((-rw.course * 180) / Math.PI);
    const lengthM = rw.length || 2000;

    for (const dir of [0, 180]) {
      const h = normDeg(headingDeg + dir);
      const key = Math.round(h);
      if (seen.has(key)) continue;
      seen.add(key);

      // Threshold of the runway you land on when flying heading h: half the
      // strip back from the centre, against the direction of travel.
      const hRad = (h * Math.PI) / 180;
      const x = rw.position.x - Math.cos(hRad) * (lengthM / 2); // DCS north
      const z = rw.position.z - Math.sin(hRad) * (lengthM / 2); // DCS east

      const designator = designatorFor(h, rw.Name, dir === 0, airbase.runwayList);
      const latRef = airbase.lat || 0;
      const lat = latRef + (x - (airbase.position ? airbase.position.x : x)) / EARTH_M_PER_DEG;
      const lon =
        (airbase.lng || 0) +
        (z - (airbase.position ? airbase.position.z : z)) /
          (EARTH_M_PER_DEG * Math.cos((latRef * Math.PI) / 180));

      out.push({
        id: `${airbase.name} ${designator}`,
        airbase: airbase.name,
        code: airbase.code || null,
        designator,
        threshold: {
          x,
          z,
          lat: round(lat, 6),
          lon: round(lon, 6),
          altFt: Math.round((rw.position.y || airbase.alt || 0) / M_PER_FT),
        },
        headingDeg: round(h, 1),
        glidepathDeg,
        lengthNm: round(lengthM / M_PER_NM, 3),
        widthM: rw.width || null,
        source: 'dcssb',
      });
    }
  }
  return out;
}

/**
 * DCS returns the designator of one end as a number (e.g. 9), while the mission
 * airbase list carries both ends as strings that may include an L/R suffix
 * ('05R' / '23L'). Prefer the list entry that matches, so the console shows the
 * same runway names the pilots read on their charts.
 */
function designatorFor(headingDeg, dcsName, isPrimary, runwayList) {
  const num = Math.round(headingDeg / 10) || 36;
  const fromList = (runwayList || []).find((n) => parseInt(String(n), 10) === num);
  if (fromList) return String(fromList).toUpperCase();
  if (isPrimary && dcsName !== undefined && dcsName !== null && String(dcsName).length) {
    const s = String(dcsName).toUpperCase();
    const m = s.match(/^(\d+)(.*)$/);
    return m ? String(parseInt(m[1], 10)).padStart(2, '0') + m[2] : s;
  }
  return String(num).padStart(2, '0');
}

function normaliseStatic(runways, glidepathDeg) {
  return runways
    .filter((r) => r && r.threshold)
    .map((r) =>
      Object.assign({ glidepathDeg, lengthNm: 1.2, source: 'config' }, r, {
        threshold: Object.assign({ altFt: 0 }, r.threshold),
      })
    );
}

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

function round(v, n) {
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

module.exports = { RunwayProvider, buildRunways };
