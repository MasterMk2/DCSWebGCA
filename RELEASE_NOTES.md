# Release Notes

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
