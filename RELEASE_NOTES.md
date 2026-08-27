# Release Notes

## v0.6.0 (2026-08-27)

### Added

- **GCI scope panning**: the PPI can be dragged with the mouse (or one finger)
  to look away from the airfield. The offset is kept in metres, so zooming and
  window resizes leave the same piece of ground in the middle of the scope, and
  the map background, range rings, runway and tracks all move together. A
  **CENTER** button recentres on the runway threshold, and the pan resets by
  itself when the runway or the server is switched. A drag that actually moved
  swallows the click that ends it, so panning never designates a TARGET by
  accident.
- **Cursor bullseye readout**: the GCI control bar shows the bullseye bearing
  and range of whatever the pointer is over (`BULLS(Blue) 274/032`, true
  bearing / nm), and the bullseye itself is drawn on the scope. When the
  mission exports one bullseye per coalition, a **BULLS** selector picks which
  reference the readout uses; the label always names it, so the enemy reference
  cannot be read off by mistake.
- **Bullseye tracking** (server): `Type=Navaid+Static+Bullseye` objects are
  kept per coalition and shipped with every `tracks` frame. The stream sends
  them once, with the initial world state, so they are held in their own map
  that `staleAfterSec` pruning never touches and only a stream restart clears.
  Bearing/range is computed in native DCS metres when both the bullseye and the
  runway carry them (exact, matching what the pilot's aircraft computes), and
  otherwise from lat/lon with the scale taken at the midpoint latitude — a
  bullseye is often 50+ nm out, far enough for the threshold's own cos(lat) to
  be several nm wrong at high latitudes.
- **Console build marker**: the browser logs `[gca] console build <id>` at
  start-up, so "the new feature is missing" can be told apart from "this
  browser is still running a cached copy" at a glance.
- **Mock bullseyes**: `tools/mock-tacview.js` streams two static bullseyes
  (Blue 25 nm north, Red 40 nm south of the threshold) once with the initial
  world state, exactly as the real host does, so the readout and the
  non-pruning path can be exercised without DCS.

### Tests

- 2 new unit tests (21 total): bullseyes stay out of the track list, survive
  pruning past `staleAfterSec`, and are cleared by `clear()` / removal lines.
- The smoke test now asserts that both mock bullseyes reach `GET /api/state`
  and every WebSocket `tracks` frame, and that no navaid leaks into the tracks.

## v0.5.0 (2026-08-24)

### Added

- **Protocol diagnostics mode** (#8): set `TACVIEW_DEBUG=1` to collect a
  one-flight picture of what the DCS host actually sends — the raw handshake
  string, `ReferenceLongitude` / `ReferenceLatitude`, a transform field-count
  histogram (3/5/9-field records), a `Type` string census, raw-vs-absolute
  coordinate samples and ground-speed statistics — exposed at
  `GET /api/diagnostics`. Optionally dump the first N raw lines to a file with
  `TACVIEW_DEBUG_DUMP`. With `TACVIEW_DEBUG` unset the collector is never
  attached, so runtime overhead is zero.
- **Mock Tacview password support**: `tools/mock-tacview.js` now honours
  `MOCK_PASSWORD` to require the `XtraLib.Stream.0\n...join <password>`
  handshake, so the password handshake path can be exercised locally without a
  real DCS server.
- **Issue #8 verification guide** (`docs/issue8-verification.md`): step-by-step
  instructions mapping each of Issue #8's seven checklist items to the specific
  diagnostics / state fields that answer it, so a single flight against a real
  DCS server completes the field verification.

### Tests

- 5 new unit tests covering the diagnostics collector (19 total); the smoke
  test now also exercises `GET /api/diagnostics`.

## v0.4.0 (2026-08-24)

### Added

- **LSO mode**: carrier landing aid view. Pick a carrier (Sea track) and an
  aircraft and the console shows a lineup cross-section plus a glideslope
  profile against the carrier's deck (3.0° reference path), with range,
  altitude above deck, GS deviation, lineup, AoA (when the stream provides it)
  and an LSO-style call ("HIGH / COME LEFT"). Wheel/pinch zoom 1–8 nm.
- **PERF indicator**: the header can show live refresh-rate / latency stats —
  UPD Hz (WebSocket frames received per second) and LAT ms (transport latency
  from the server's `sentAt` stamp). Toggled with the PERF button and the
  on/off state is persisted in `localStorage`.
- **LSO Platform View**: pseudo view from the LSO platform astern of the
  carrier. The horizon rolls against the lineup error, the flight deck rides
  up/down against the glideslope error, and the aircraft is drawn as a
  range-scaled aft silhouette against the fixed 3.0° datum line with an
  LSO-style callout — above/below path and deck up/down at a glance.
- **Map background**: the GCI PPI and TWR field scopes can overlay dimmed
  OpenStreetMap tiles as a geographic underlay. Toggled with the MAP button
  (persisted in `localStorage`); tile load failures fall back silently to the
  plain radar display so offline operation is unaffected.
- **Receive-latency indicator**: the server now stamps each `tracks` frame with
  a `sentAt` timestamp and the console shows the transport latency (LAT) in the
  header, falling back to snapshot age when client/server clocks diverge.
- **Mock carrier**: `tools/mock-tacview.js` now also streams a slow-steaming
  carrier (`CVN-71`, `Sea+Watercraft`) on the extended centreline plus an
  F/A-18C riding the 3° glideslope from 5 nm astern, so the LSO mode (carrier
  dropdown, lineup cross-section, Platform View) can be verified in the browser
  without DCS. The server-side snapshot now passes Sea tracks through so the
  CARRIER dropdown can be populated.

### Fixed

- **LSO header text overprint**: the mode label in the top-left corner of the
  LSO scope was drawn repeatedly on top of itself, smearing into an unreadable
  blob. `grid()` now takes a `yLabelX` argument so each view places its
  y-axis labels at its own x offset.
- **LSO Platform View viewpoint**: the pseudo view no longer follows the
  aircraft; it is now pinned to a fixed LSO-platform vantage point astern of
  the carrier, so horizon roll and deck ride read correctly against the 3.0°
  datum line.
- **Mock localizer warp**: `tools/mock-tacview.js` could teleport the aircraft
  across the localizer when wrapping around. The mock now flies a full
  landing-cycle round trip (5 nm final → deck → climb-out → re-entry to the
  abeam start) instead of hard-wrapping, so LSO/GCA sessions run continuously.
- **Smoke test**: `tools/smoke-test.js` now also verifies that every `tracks`
  frame carries a numeric `sentAt` timestamp, guarding the latency display.

## v0.3.0 (2026-08-22)

Security, usability and robustness release.

### Added

- **Token authentication** (#3): set `auth.token` in `config.json` to protect
  `/api/*` and `/ws`. The token is accepted as `?token=...` or an
  `Authorization: Bearer` header; WebSocket upgrades are verified the same way.
  The browser console picks the token up from the URL once and remembers it in
  `localStorage`. Empty token = no auth (previous behaviour).
- **GCA scope zoom** (#5): the azimuth/elevation scopes now share an adjustable
  range (2–30 nm) driven by mouse wheel on desktop and pinch gestures on
  mobile, matching GCI/TWR behaviour. The altitude axis keeps following the
  glidepath so the beam stays mid-screen at any range.
- **Talk-down phrase templates** (#6): every phrase of the PAR talk-down
  generator is overridable through `gca.phrases` in `config.json`
  (`intro`, `onCourse`, `slightlyOffCourse`, `offCourse`, `reportAltitude`,
  `onGlidepath`, `offGlidepathHigh`, `offGlidepathLow`, `overThreshold`,
  `oneMile`) with `{callsign} {range} {side} {other} {heading} {dir}
  {intensity} {altitude} {verb}` placeholders — config-only localisation,
  Japanese templates included as a comment example.
- **DPR-aware canvases** (#7): all scopes render at device resolution so text
  and symbols stay crisp on HD/Retina displays; re-applied on resize and
  orientation change.

### Changed

- **Broadcast efficiency** (#7): each snapshot frame is JSON-serialised once
  per tick and the same buffer is fanned out to every subscriber instead of
  being serialised per connection.
- Talk-down state now also honours `gca.talkdownIntervalSec` /
  `gca.talkdownMaxRangeNm` from config.

### Fixed

- **Handshake robustness** (#7): a host that accepts the TCP connection but
  never completes the `XtraLib.Stream.0` handshake is now dropped after 10 s
  and retried with backoff, instead of hanging forever. An idle stream
  (no data for 60 s) also forces a reconnect to survive half-open sockets.

### Notes

- Docker images are published automatically for tags:
  `ghcr.io/mastermk2/dcswebgca:v0.3.0`.
- No breaking config changes; existing `config.json` files keep working.

## v0.2.0 (2026-08-22)

Multi-server console with graduated phraseology, mobile support and CI.

- Multi-source architecture: one process subscribes to several DCS servers
  (`sources[]`), browsers pick their own (server, runway) pair.
- Graduated PAR phraseology (slightly / well bands, turn-heading calls).
- Per-aircraft Approach Digest panel with deviation sparklines and grading.
- Smartphone/tablet layout: responsive two-column grid collapses to one,
  touch-friendly controls, pinch zoom on scopes.
- GitHub Actions CI (unit tests + end-to-end smoke test against the mock
  Tacview server) and automated GHCR Docker builds.
- Runway geometry pulled from DCS itself via DCSServerBot RestAPI, cached per
  theatre on disk; hand-written runways still supported as override/fallback.

## v0.1.0 (2026-08-21)

Initial public release.

- Tacview real-time ACMI 2.2 telemetry client (XtraLib handshake, relative
  lon/lat, 3/5/9-field transforms, u/v native DCS coordinates).
- GCA (PAR) mode: azimuth + elevation scopes, approach data table,
  automatic talk-down log.
- GCI mode: PPI scope with intercept solution (STEER / CLOSURE / TTI).
- TWR mode: aerodrome view with extended centreline and field traffic list.
- WebSocket hub fanning out per-subscription snapshots at 5 Hz.
- Docker image, systemd unit and nginx reverse-proxy examples.
