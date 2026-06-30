# Project Status

This document tracks what currently works, what is limited or unfinished, and what could be added next.

Contrail is an unofficial, local IVAO Altitude companion. It should be treated as an experimental personal-use project.

## How It Works

Contrail is a local bridge for the normal Altitude data flow. It is intended to run on the same PC as IVAO Altitude.

1. PilotUI is configured to use the local IPv4 address printed by Contrail as its `Simulator Address`.
2. PilotUI connects to Contrail on the simulator/core port instead of connecting directly to PilotCore.
3. Contrail forwards that traffic to PilotCore, preserving the normal PilotUI/PilotCore flow.
4. When PilotCore receives the IVAO FSD endpoint, Contrail rewrites it to `127.0.0.1` so the FSD connection is routed through the local proxy.
5. The FSD proxy forwards traffic to the real IVAO server and parses useful data: messages, weather replies, ATC stations, aircraft position, COM updates, and voice-channel announcements.
6. When IVAO announces a TS2 voice server, Contrail rewrites the server address to the local network IP selected at startup.
7. TS2 UDP voice traffic then passes through Contrail, which forwards it to the real TS2 server.
8. Incoming voice packets are decoded with ffmpeg and streamed to the browser as PCM audio.
9. Browser microphone audio is encoded with ffmpeg/libspeex and sent back through the cached TS2 transmit session.

The webapp is only a local control surface. It talks to Contrail over WebSocket and does not connect directly to IVAO.

## Working

### Local Proxy

- PilotUI can connect to Contrail on the simulator/core port.
- Contrail forwards simulator/core traffic to PilotCore.
- Contrail intercepts IVAO FSD traffic through the local FSD proxy.
- Contrail rewrites IVAO TS2 voice server announcements so TS2 voice traffic passes through the local proxy.
- The simulator address is detected automatically from local IPv4 interfaces, including Ethernet and Wi-Fi.
- If multiple usable local IP addresses exist, Contrail prints the detected candidates.
- `config.json` can override the detected address with `lanIp`.

### Webapp

- Local webapp runs at `http://localhost:3000` and is bound to loopback by default.
- Header shows connection state, callsign, and the simulator address to use in Altitude.
- Header shows flight plan status and suppresses repeated `FSD_FPL_ERROR` chat noise.
- The webapp reconnects automatically after temporary WebSocket disconnects or browser standby.
- The webapp has heartbeat `ping` / `pong` handling for stale control connections.
- The webapp immediately rebuilds stale control WebSockets after standby/focus when the last pong is old.
- The normal UI does not expose raw protocol logs.
- Parsed FSD events sent to the browser do not include raw FSD lines.
- A `Settings` modal groups audio state, connection state, and app information without crowding the sidebar.
- Layout keeps header/sidebar/composer fixed while the message view scrolls.

### Radio

- COM1 and COM2 can be tuned from the webapp.
- COM inputs auto-format typed digits, for example `124850` becomes `124.850`, and tune automatically when complete.
- Current COM1 and COM2 frequencies are restored when the webapp reloads.
- Startup COM state is learned from PilotUI/PilotCore binary radio commands and framed status payloads.
- COM station dropdown selections and station snapshots are restored when the webapp reloads.
- Available ATC stations are detected from FSD/voice traffic.
- UNICOM `122.800` is always available in the COM station dropdowns.
- `_OBS` stations are hidden.
- Station dropdowns are available under COM1 and COM2.
- Stations are sorted by distance when aircraft and station coordinates are available.
- `TX COM1` and `TX COM2` are placed inside their matching COM cards.
- Web TX readiness is shown directly under the COM cards.

### Transponder

- Squawk can be set from the webapp.
- `STBY` / `ALT` can be toggled from the webapp.
- IDENT can be sent from the webapp.
- The IDENT button stays red for 5 seconds after activation.
- The last squawk and `STBY` / `ALT` selection survive a webapp refresh through browser storage.
- Squawk and `STBY` / `ALT` changes made outside the webapp are learned from outgoing IVAO/FSD position updates.
- `STBY` / `ALT` web commands still use PilotCore's toggle packet; FSD feedback corrects the visible state after PilotCore reports it.

### Text Messages

- Frequency messages work.
- Private messages work.
- Broadcast messages work.
- `.metar ICAO` and `.wx ICAO` work.
- `.taf ICAO` works.
- `.atis CALLSIGN` works.
- `.msg CALLSIGN text` and `.m CALLSIGN text` work.
- `.chat CALLSIGN` opens a private chat tab.
- `.chat CALLSIGN text` opens a private chat tab and sends the message.
- Dot-command autocomplete opens when the message starts with `.` and supports keyboard completion.
- Incoming private messages automatically create/selectable private conversation tabs.
- Private conversation tabs can be closed with `x`.

### Voice RX

- Incoming TS2 voice is decoded through ffmpeg and played in the webapp.
- The `RX` indicator lights when received audio is played.
- RX audio continues to work after normal webapp reconnects.

### Voice TX

- Web microphone TX works on COM1 and COM2.
- Web TX mirrors the TX state into Altitude so the Altitude TX indicator lights.
- The webapp shows whether Web TX is ready or waiting for a voice-channel session.
- A 300 ms Web TX release tail is implemented to reduce clipped final syllables; it still needs live listener validation.
- Current working TX profile:

  ```text
  Sample rate: 8000 Hz
  Speex quality: 10
  Frames per packet: 5
  TS2 packet size: 325 bytes
  Payload: 0x05 + 308 Speex bytes
  Packet interval: configured in config.json
  ```

- `Monitor TX` plays locally encoded microphone audio without transmitting to IVAO.
- `Test RX` plays a local test tone for browser audio output.
- Audio diagnostics are available from the `Settings` modal.

### Remote Preview

- Shared remote protocol validation exists in `packages/protocol`.
- Early relay skeleton exists in `apps/relay`.
- Relay development settings can be loaded from `apps/relay/.env` with `npm run relay:env`.
- Remote preview testing is documented in [Remote Testing](REMOTE_TESTING.md) and assisted by `npm run remote:check`.
- Automated Remote Preview relay simulation is available with `npm run remote:test`.
- Self-host preview files exist in `infra/docker` with Docker Compose, a relay
  container, hosted static webapp serving, Caddy HTTPS/WSS reverse proxy, and a
  persisted relay data volume.
- Relay supports in-memory agent registration, browser pairing, pairing persistence, browser-side revocation, admin-side pairing revocation in SQLite modes, and narrow allowlisted message routing.
- Relay startup requires an explicit `CONTRAIL_RELAY_TOKEN` and does not print complete relay tokens in startup logs.
- Relay has simple per-connection limits for total messages, browser commands,
  pairing attempts, and connected clients.
- The local proxy can optionally connect outbound to a relay as an early remote agent.
- Remote agent mode is disabled by default in `config.json`.
- The remote agent maps routed `radio.set`, `chat.send`, and `xpdr.*` commands onto the same local functions used by the local webapp.
- The remote agent applies a small agent-side rate limit before touching PilotCore or FSD. PTT start/stop commands are excluded so Remote TX testing is not blocked by command flood protection.
- The remote agent publishes local status, COM state, and chat messages back through the relay.
- The remote agent publishes station snapshots and own-position data so remote COM dropdowns can be rebuilt and distance-sorted.
- The remote agent forwards decoded RX PCM audio through the relay to paired browsers watching the agent.
- Remote TX preview routing forwards browser microphone PCM through the relay to the local Web TX encoder while a paired remote browser is holding TX.
- Remote RX audio has been confirmed in live self-hosted relay tests, including
  simultaneous playback on a PC browser and a mobile browser. In early tests,
  perceived added latency was low, roughly under 200 ms. A separate
  iPhone-over-4G test also confirmed that the hosted webapp can work from an
  external mobile network.
- Remote TX audio has been confirmed in live IVAO listener tests. Current
  diagnostics show remote microphone PCM reaching the local agent, Web TX
  producing Speex packets, and TS2-shaped voice packets leaving the proxy with
  zero send failures in the successful test.
- The webapp has an early remote-browser mode enabled with `?remote=1&relay=...&token=...`.
- On public HTTPS hosts, the webapp defaults to Remote Preview mode because a
  hosted static page cannot use the local proxy WebSocket at `/ws`.
- `Settings > Remote` can save relay URL, token, and a temporary pairing code in browser storage for preview testing.
- The local webapp can request a fresh Remote Preview pairing code without restarting the proxy.
- The local webapp can copy the current Remote Preview pairing code from `Settings > Remote`.
- The clean webapp URL stays local by default; remote preview must be activated explicitly.
- `Settings > Remote` shows relay status, relay health/preflight result,
  browser pairing status, selected agent, online agent count, and last remote
  update.
- The relay health endpoint can be checked from an allowlisted hosted webapp
  origin through CORS.
- The intended remote model is one agent per user and multiple browser devices controlling that same agent.
- The relay has a first multi-user preview layer through scoped relay tokens:
  one self-hosted relay can serve multiple independent users, and each token can
  see only its own agents, pairings, commands, and audio.
- The relay also has an optional SQLite account-registration/login preview:
  hosted browsers can authenticate with an HttpOnly session cookie, while the
  local proxy still uses a one-time generated agent token in `config.json`.
- Logged-in account browsers can see and select agents owned by the same
  account without entering a pairing code.
- The relay sends an authenticated user-scope identity message after connect,
  and `Settings > Remote` displays that scope so token mistakes are visible.
- `npm run relay:user` can add, rotate, remove, list, or print preview relay
  user tokens in an existing `.env` file without editing the long
  `CONTRAIL_RELAY_USERS` line by hand.
- `Settings > Remote` includes a concise Remote Status line that highlights
  disconnected relay, missing identity, valid token with no online agent,
  unpaired browser, offline paired agent, or ready state.
- Hosted account registration/login now lives on the first Remote webapp screen.
  `Settings > Remote` keeps logout, agent-token rotation, relay status, and the
  manual token/pairing fallback tools.
- Verified remote-browser controls: pairing, pairing persistence/revocation,
  COM1/COM2, station dropdowns, chat, dot commands, METAR/TAF/ATIS, XPDR
  squawk, STBY/ALT, IDENT, Remote RX binary audio forwarding with PC/mobile
  playback, Remote TX binary audio forwarding, and live Remote TX received by
  another IVAO user.

## Known Limitations

- Web TX now attempts to derive the TS2 transmit session from voice-channel join/setup traffic. Pressing the real Altitude PTT once remains the fallback if derivation does not work for a server/session variant.
- Web TX may have a slight crackle compared with native Altitude TX, although remote users can understand it.
- IVAO does not echo the user's own TX audio, so final TX confirmation requires another listener.
- Message history is intentionally in memory. Recent messages survive a webapp refresh while the proxy keeps running, but not a full proxy restart.
- The webapp can be served by the local proxy or by the self-host preview Caddy stack.
- Remote Preview is verified for controls, Remote RX audio forwarding on PC and
  mobile, Remote TX routing, live self-hosted relay tests, and live IVAO Remote
  TX received by another user. The relay can be self-hosted with the
  Docker/Caddy preview files. It includes SQLite hosted-account login/session
  preview, but it is not a complete production remote product: production
  authorization, full account lifecycle, broad audit coverage, and broader
  live-audio validation across more networks/listeners are not complete yet.
- The proxy is designed to run locally. It is not hardened for exposure to the public internet.
- ffmpeg must currently be installed on the PC and available to the Node process.
- Full Altitude/IVAO integration tests are not yet present. A local verification
  self-test is available with `npm run verify`, and a relay/agent/browser Remote
  Preview simulation is available with `npm run remote:test`.
- GitHub Actions runs `npm run verify` and `npm run remote:test` on Windows and
  Linux for pushes and pull requests to `main` or `master`.
- GitHub issue templates, pull request template, release notes, and security
  policy are present for the first public publication.
- A first technical paper draft exists in [Technical Paper](TECHNICAL_PAPER.md).
- A dependency and license policy exists in
  [Dependency And License Policy](DEPENDENCY_POLICY.md).
- The first SQLite/dashboard schema draft exists in
  [Database Design](DATABASE_DESIGN.md).
- `better-sqlite3` is installed as the SQLite wrapper, the Node.js baseline is
  now Node 20 or newer, and the npm audit is clean after updating `ws`.
- The relay has a small SQLite module and initial migration for users, agent
  tokens, agents, browser pairings, browser sessions, and audit events.
- The SQLite foundation is tested with a temporary database during
  `npm run verify`.
- Relay authentication uses `.env` tokens by default with
  `CONTRAIL_RELAY_AUTH_MODE=env`, but can now load active SQLite token records
  with `CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback`.
- `CONTRAIL_RELAY_AUTH_MODE=sqlite` disables the `.env` fallback after DB
  tokens are confirmed to work.
- Browser pairing persistence uses `pairings.json` in `.env` auth mode and SQLite in `sqlite-fallback`/`sqlite` modes.
- `npm run relay:db:import-users` can import `CONTRAIL_RELAY_USERS` and the
  legacy `CONTRAIL_RELAY_TOKEN` into SQLite as users and agent tokens. It is
  idempotent and rotates DB token records when the `.env` token changes.
- `npm run relay:db:user` can manage SQLite relay users directly: list, add,
  rotate tokens, revoke tokens, disable/enable users, delete users, print a
  token entry, and create a SQLite backup.
- The relay has a minimal `/admin` panel protected by
  `CONTRAIL_RELAY_ADMIN_TOKEN` for SQLite modes. It can list users, create
  users, rotate/revoke tokens, disable/enable users, delete users, list known
  devices, list active browser pairings, revoke a browser pairing, and show
  recent audit events.
- The relay writes a minimal SQLite audit log for admin user/token actions,
  agent connect/disconnect events, and browser pairing create/revoke events.

## Future Features

### Distribution And Release Packaging

- Keep one source repository, but publish separate release artifacts for
  different user needs.
- Prepare **Contrail Local** as the light download for normal pilots: local
  proxy/agent, local webapp, start scripts, and config examples.
- Prepare **Contrail Hosted Webapp** as the static browser UI artifact for an
  official, community, or private HTTPS host.
- Prepare **Contrail Server** as the VPS/self-host package: relay, hosted
  webapp, Docker/Caddy files, SQLite/admin tooling, and deployment docs.
- Keep **Contrail Full Source** for contributors, auditors, and advanced
  self-hosters who want every component, test, and design document.
- Document the phone-as-microphone workflow as a supported Remote mode use case:
  Altitude and the proxy stay on the simulator PC, while a phone or tablet
  browser provides the microphone and receives RX audio.

### Remote And Self-Hosted Relay Mode

- Harden Docker Compose self-hosting beyond the current private preview.
- Harden the preview account authentication into a production account system,
  following [Authentication Architecture](AUTH_ARCHITECTURE.md).
- Build the admin/dashboard UI on top of the implemented SQLite schema for
  users, agent tokens, browser pairings, sessions, and audit events.
- Add richer account/device management for browser sessions and agent tokens.
- Expand the minimal `/admin` panel into a fuller production dashboard with
  sessions, richer audit views, pairing management, and clearer deployment
  controls.
- Expand security/audit logging for login/session events and production
  authorization failures.
- Add documented official relay, community relay, and private self-hosted relay modes.
- Add an official hosted webapp deployment path in addition to the current
  self-host static webapp preview.
- Add abuse/rate-limit controls suitable for a public or community relay.
- Keep the proxy local/offline; do not expose PilotUI/PilotCore, FSD, or TS2 ports publicly.

### User Experience

- Add a first-run checklist for Altitude setup.
- Add clearer microphone permission/error states.
- Add import/export for settings.
- Add a dedicated mobile UI for phones and tablets instead of relying only on the desktop layout.
- Add clearer paired-browser management and revocation visibility.
- Live-validate Web TX session derivation across more TS2 server/session variants so the real Altitude PTT fallback can eventually be removed.

### Reliability

- Add full integration tests around proxy startup and WebSocket recovery.
- Expand `Settings > Audio` diagnostics with microphone level, selected input device, browser audio output, ffmpeg availability, and local monitor status.
- Improve RX audio mixing/buffering when two stations transmit at the same time. Both voices are currently audible, but overlapping packets can make playback cut out or stutter.
- Validate the 300 ms Web TX release tail with a live listener and tune the duration if final syllables are still clipped.
- Improve Web TX PTT start handling if first syllables are still clipped. Microphone pre-roll is intentionally deferred because it would require keeping the microphone armed before PTT.

### Documentation

- Expand and maintain [Technical Paper](TECHNICAL_PAPER.md) as the architecture, relay, audio, and security model evolve.
- Expand and maintain [Authentication Architecture](AUTH_ARCHITECTURE.md) as production authentication, account sessions, and agent tokens evolve.

### Maintainability

- Keep the modular proxy layout small and reviewable. `proxy.js` is now mostly
  bootstrap; PilotUI/PilotCore, FSD, TS2/RX, Web TX, local HTTP/WebSocket, remote
  agent, and UI-visible state live in focused modules under `proxy/`.
- Keep remote audio simple and live-only while tightening Remote TX live validation, explicit PTT safety, and disconnect handling.
- Keep ffmpeg in the threat model as an untrusted audio parser even though it is launched with fixed `spawn()` arguments.

## Not Planned

- Running the proxy on a public server.
- Exposing simulator/core, FSD, or TS2 proxy ports directly to the internet.
- Storing IVAO credentials.
- Persisting chat history and private chat tabs across full proxy restarts.
- Replacing Altitude itself.
