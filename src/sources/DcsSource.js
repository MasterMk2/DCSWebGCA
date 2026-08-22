'use strict';

/**
 * One DCS server: Tacview stream -> track store -> runway-relative snapshots.
 *
 * Talk-down state is kept per runway (several controllers may work different
 * runways of the same server at the same time), and only for runways somebody
 * is actually watching.
 */

const { TacviewClient } = require('../acmi/TacviewClient');
const { TrackStore } = require('../acmi/TrackStore');
const { Talkdown } = require('../acmi/Talkdown');
const { RunwayProvider } = require('../runways/RunwayProvider');

const TRANSCRIPT_KEEP = 100;
const MISSION_REFRESH_DELAY_MS = 15000;

class DcsSource {
  constructor(cfg, srcCfg) {
    this.cfg = cfg;
    this.id = srcCfg.id;
    this.name = srcCfg.name;
    this.config = srcCfg;

    this.store = new TrackStore(cfg, srcCfg.id);
    this.runwayProvider = new RunwayProvider(cfg, srcCfg);
    this.talkdowns = new Map(); // runwayId -> { talkdown, transcript }
    this.client = new TacviewClient(srcCfg.tacview, srcCfg.id);

    this.client.on('update', (u) => this.store.applyUpdate(u));
    this.client.on('remove', (id) => this.store.remove(id));
    this.client.on('restart', () => this.store.clear());
    this.client.on('disconnected', () => this.store.clear());
    this.client.on('mission', (title) => {
      console.log(`[${this.id}] mission: ${title}`);
      if (this.cfg.dcssb.refreshOnMissionChange) {
        // Give DCSServerBot a moment to pick up the new mission before asking
        // it what the airbases look like.
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.runwayProvider.refresh(), MISSION_REFRESH_DELAY_MS);
      }
    });
  }

  start() {
    this.client.start();
    this.runwayProvider.refresh();
  }

  stop() {
    clearTimeout(this.refreshTimer);
    this.client.stop();
  }

  get runways() {
    return this.runwayProvider.runways;
  }

  /**
   * The runway a freshly opened console starts on: the configured one if it
   * exists, otherwise the home airbase's end that is closest to into-wind, so
   * a controller lands on the same runway the AI ATC is using.
   */
  defaultRunwayId() {
    const runways = this.runways;
    if (!runways.length) return null;

    const wanted = this.config.defaultRunway;
    if (wanted && this.runwayProvider.find(wanted)) return wanted;

    const airbase = this.config.defaultAirbase || wanted;
    if (airbase) {
      const needle = String(airbase).toLowerCase();
      const candidates = runways.filter((r) => String(r.airbase || r.id).toLowerCase().startsWith(needle));
      if (candidates.length) return this.pickIntoWind(candidates).id;
    }
    return runways[0].id;
  }

  pickIntoWind(candidates) {
    const wind = this.runwayProvider.weather;
    if (!wind || !wind.windSpeedMs || wind.windSpeedMs < 1 || wind.windFromDeg === null) return candidates[0];
    const off = (r) => Math.abs(((r.headingDeg - wind.windFromDeg + 540) % 360) - 180);
    return candidates.reduce((best, r) => (off(r) < off(best) ? r : best), candidates[0]);
  }

  resolveRunway(runwayId) {
    return this.runwayProvider.find(runwayId) || this.runwayProvider.find(this.defaultRunwayId());
  }

  snapshot(runwayId) {
    const rwy = this.resolveRunway(runwayId);
    const snap = this.store.snapshot(rwy);
    snap.sourceId = this.id;
    // the console needs the full runway object (heading/glidepath/threshold)
    snap.runway = rwy;
    snap.counts = { objects: this.store.tracks.size };
    return snap;
  }

  /** Advance the talk-down generator for one runway and return the new calls. */
  tickTalkdown(snap) {
    const rwy = snap.runway;
    if (!rwy) return [];
    let entry = this.talkdowns.get(rwy.id);
    if (!entry) {
      entry = { talkdown: new Talkdown(this.cfg), transcript: [] };
      this.talkdowns.set(rwy.id, entry);
    }
    const msgs = entry.talkdown.update(snap.tracks, rwy);
    if (msgs.length) {
      entry.transcript.push(...msgs);
      if (entry.transcript.length > TRANSCRIPT_KEEP) {
        entry.transcript.splice(0, entry.transcript.length - TRANSCRIPT_KEEP);
      }
    }
    return msgs;
  }

  transcript(runwayId) {
    const entry = this.talkdowns.get(runwayId);
    return entry ? entry.transcript : [];
  }

  /** Drop talk-down state for runways nobody is watching any more. */
  retainTalkdowns(runwayIds) {
    for (const id of [...this.talkdowns.keys()]) {
      if (!runwayIds.has(id)) this.talkdowns.delete(id);
    }
  }

  get status() {
    const tv = this.client.status;
    return {
      id: this.id,
      name: this.name,
      connected: tv.connected,
      tacview: `${tv.host}:${tv.port}`,
      mission: tv.mission,
      lastDataAt: tv.lastDataAt,
      runways: this.runwayProvider.status,
      objects: this.store.tracks.size,
    };
  }
}

module.exports = { DcsSource };
