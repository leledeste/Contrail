# Changelog

All notable changes to Contrail are tracked here.

## v0.1.0 - 2026-06-27

Initial public release.

### Added

- Local PilotUI/PilotCore bridge.
- Local FSD proxy for IVAO messages, commands, weather replies, ATC station data, and voice announcements.
- TS2 voice proxy with RX voice playback in the browser.
- Browser Web TX on COM1/COM2 through the cached Altitude TS2 transmit session.
- Browser radio controls with COM1/COM2 manual tuning and station dropdowns.
- Persistent `UNICOM - 122.800` option in both COM station dropdowns.
- `_OBS` station filtering.
- Distance-sorted station dropdowns when aircraft and station coordinates are available.
- Message views for all, frequency, private, per-peer private tabs, and system messages.
- Dot-command autocomplete for `.metar`, `.taf`, `.atis`, `.msg`, `.chat`, COM tuning, squawk, XPDR, and IDENT commands.
- Webapp XPDR panel with squawk, `STBY` / `ALT`, and 5-second red IDENT feedback.
- Flight plan status pill that suppresses repeated `FSD_FPL_ERROR` chat noise.
- Settings modal with Audio, Connection, Remote, and About sections.
- WebSocket heartbeat `ping` / `pong` handling to recover stale webapp connections after standby.
- Startup validation for `config.json` with clear fallback warnings.
- `npm run verify` local project self-test.
- `npm run remote:test` relay/agent/browser Remote Preview simulation without Altitude or IVAO.
- GitHub Actions CI for Windows and Linux with `npm run verify` and `npm run remote:test`.
- GitHub issue templates, pull request template, and release notes for first publication.
- `packages/protocol` with allowlisted Contrail Remote message validation.
- `apps/relay` Remote Preview relay with healthcheck, WebSocket gate, origin allowlist, token gate, protocol validation, agent registration, browser pairing, pairing persistence, and browser-side revocation.
- Optional `CONTRAIL_RELAY_USERS` token registry for multi-user preview isolation on one self-hosted relay.
- `npm run relay:user` helper for adding, rotating, removing, listing, and printing preview relay user tokens in `.env` files.
- Simple per-connection relay pressure limits for clients, messages, browser commands, and pairing attempts.
- Relay startup now requires an explicit `CONTRAIL_RELAY_TOKEN` instead of printing generated full tokens.
- `Settings > Remote` with relay URL/token/pairing fields, relay health check, pairing status, agent status, and last-update state.
- `Settings > Remote` now shows the authenticated relay user scope reported by the relay.
- `Settings > Remote` now includes a concise Remote Status summary for relay, identity, agent, and pairing readiness.
- `Settings > Remote > Renew Pairing Code` in the local webapp, so a fresh Remote Preview code can be issued without restarting the proxy.
- `Settings > Remote > Copy Pairing Code` for quickly copying the current Remote Preview pairing code.
- Optional outbound remote-agent mode in the local proxy, disabled by default.
- Non-audio Remote Preview routing for radio, chat, METAR/TAF/ATIS, station snapshots, and XPDR commands.
- Remote RX preview forwarding with live binary PCM from the local agent to selected paired browsers.
- Remote TX preview forwarding with live browser microphone PCM routed through the relay into the local Web TX encoder.
- Self-host preview files in `infra/docker` with Docker Compose, Caddy HTTPS/WSS reverse proxy, hosted static webapp serving, and relay data volume.
- Remote access, self-hosting, security, privacy, threat-model, and developer-tool documentation.
- Dependency and license policy for future open-source dependency review.
- Initial SQLite database design for future relay users, agent tokens, browser pairings, sessions, and audit events.
- SQLite relay database foundation with `better-sqlite3`, initial identity/control-plane migration, and a temporary-database migration test.
- `.env` to SQLite relay-user import helper for preparing DB-backed authentication without changing relay auth behavior yet.
- Optional DB-backed relay token authentication with `.env`, SQLite fallback, and SQLite-only modes.
- `npm run db:auth:test` relay smoke test for SQLite token auth, `.env` fallback, and SQLite-only rejection.
- `npm run relay:db:user` SQLite relay user helper for listing users, adding
  users, rotating/revoking tokens, disabling/enabling users, and creating DB
  backups.
- `npm run db:user:test` coverage for the SQLite relay user helper.
- Minimal relay `/admin` panel and protected `/admin/api/*` endpoints for
  SQLite user/token management, including permanent user deletion.
- `npm run relay:admin:test` coverage for admin token protection, env-mode
  blocking, and SQLite user lifecycle actions through the admin API.
- Optional SQLite hosted-account preview with registration/login endpoints,
  HttpOnly browser session cookies, one-time agent token creation, account-side
  agent-token rotation, and session-authenticated browser WebSocket access.
- Hosted Remote first-run login/register screen for SQLite account mode.
- `Settings > Remote` account controls for logout, local proxy agent-token
  rotation, relay status, and manual token/pairing fallback tools.
- Hosted account login/register remains visible on first load even when a
  browser still has an older manual relay token saved; manual token mode is now
  an explicit fallback choice.
- Account API responses now include stable error codes for duplicate usernames,
  disabled registration, invalid credentials, and expired sessions so the
  webapp can show clearer login/register messages.
- The webapp has been split from one large inline file into `index.html`,
  `styles.css`, and `app.js`, making the next UI rewrite easier to review.
- `proxy.js` now delegates config loading, port diagnostics, static web serving,
  and Ogg/Speex helpers to small modules under `proxy/`.
- `npm run relay:account:test` coverage for account registration, session
  WebSocket authentication, agent-token rotation, and logged-in browser command
  routing without pairing.
- SQLite-backed browser pairing persistence for `sqlite-fallback` and
  `sqlite` relay modes, while `env` mode keeps the JSON pairing store.
- Relay admin panel views for known devices and active browser pairings, with
  admin-side pairing revocation.
- Minimal SQLite audit log for admin actions, agent connect/disconnect, and
  browser pairing create/revoke events, shown in the relay admin panel.
- Technical paper draft covering architecture, local proxying, voice, Remote Preview, security, privacy, and implementation technologies.
- Usage mode guide for local users, hosted browsers, self-hosted servers, and
  full-source developers.
- Documented the phone-as-microphone Remote mode use case for simulator PCs
  without a usable local microphone.
- Documented planned release artifacts for Local, Hosted Webapp, Server, and
  Full Source distributions.
- Authentication architecture proposal for multi-user hosting, per-agent tokens, browser sessions, custom roles, COM-specific TX permissions, and atomic TX locks.
- Documentation recommends `openssl rand -hex 32` relay tokens to avoid manual URL escaping issues.
- Documentation explains the `.env`, SQLite-with-fallback, and SQLite-only
  relay authentication modes with migration guidance.
- GitHub issue templates and pull request template.
- MIT license and third-party notices.

### Changed

- Moved `TX COM1` and `TX COM2` into their matching COM cards.
- Moved Web TX readiness under the COM cards.
- Removed duplicate sidebar audio controls in favor of the Settings modal.
- Removed the chat `Clear` control to avoid ambiguous message deletion.
- Replaced manual COM `Set` buttons with auto-formatting COM inputs that tune automatically when complete.
- Replaced repeated `Web TX is not ready` chat spam with a slow waiting pulse and temporary first-PTT reminder.
- Public HTTPS webapp hosts default to Remote Preview mode instead of attempting a local `/ws` proxy connection.
- Remote Preview assumes one local agent per user with multiple browser clients, instead of manual device switching.
- Planned mobile UI is tracked separately from the current desktop-first responsive layout.
- Split socket guards, FSD parsing/sanitizing, and PilotCore packet helpers into
  focused `proxy/` modules so `proxy.js` contains less protocol detail.
- Split the Remote Agent relay client and local WebSocket command dispatcher
  into focused `proxy/` modules.
- Split browser Web TX encoding, monitoring, TS2 packet shaping, and TX session
  caching into a focused `proxy/web-tx.js` module.
- Split TS2 TCP/UDP forwarding and browser RX voice decoding into a focused
  `proxy/ts2-voice-proxy.js` module.
- Split the PilotUI/PilotCore 4827 bridge into a focused
  `proxy/pilot-bridge.js` module.
- Split the FSD 6809 proxy, FSD chat/weather commands, and VOICE reply
  rewriting into a focused `proxy/fsd-proxy.js` module.
- Split UI-visible runtime state for callsign, connection, radios, XPDR,
  flight plan, stations, and chat history into `proxy/app-state.js`.
- Split the local static web server, `/ws` handling, browser command dispatch,
  local origin checks, test tone, and browser RX fan-out into
  `proxy/local-web-server.js`.

### Fixed

- Restored COM1/COM2 frequencies after webapp reload.
- Restored COM station snapshots after webapp reload.
- Fixed UNICOM selection from COM dropdowns.
- Tightened local, remote, and protocol-level COM frequency validation to the normal VHF COM range.
- Restricted relay WebSocket clients to browser and agent sources only.
- Masked relay tokens in the remote preflight output to avoid leaking complete secrets in console logs or screenshots.
- Trimmed outgoing FSD text by UTF-8 byte length instead of JavaScript character length.
- Replaced raw FSD chat console logs with content-free message summaries.
- Stripped raw FSD lines before broadcasting parsed events to browser clients.
- Added relay audio frame-size validation for Remote RX/TX without rate-limiting live audio streams.
- Added relay guardrails for Remote TX audio: selected-agent checks, `CTX1` frame prefixing, per-connection pressure limits, maximum TX duration, and stop-on-disconnect behavior.
- Fixed Remote RX playback on browsers that ignore the requested `AudioContext` sample rate by scheduling PCM buffers at the real RX sample rate.
- Made `Test RX` unlock and test browser audio locally in Remote Preview.
- Kept `Test RX` enabled in Remote Preview even when TX controls are disabled.
- Removed Remote Preview audio frame-count and byte-count rate limits so long RX/TX audio streams do not get cut off by relay pressure control.
- Removed Remote Preview TX start/stop from command-rate limiting so repeated
  PTT testing cannot silently block Web TX startup.
- Updated `ws` to a non-vulnerable release after npm audit.
- Split relay rate-limit error text for messages, commands, pairing attempts, and audio frames.
- Fixed a Remote Preview device selection loop where repeated `device.state` updates could make the browser send `device.select` until the relay message limiter fired.
- Fixed Remote Preview TX setup so the hosted browser follows the local agent Web TX readiness and microphone sample rate instead of using a stale browser fallback.
- Added a short Web TX release tail so the final syllable is less likely to be clipped when PTT is released; live validation is still pending.
- Confirmed Remote RX audio in a live self-hosted relay test with low perceived added latency, roughly under 200 ms in that environment.
- Confirmed Remote TX audio in one live IVAO listener test with reported 5/5 intelligibility.
- Confirmed hosted Remote Preview access from an iPhone over a 4G mobile network.
- Improved startup COM restore by learning radio frequencies from both PilotUI-to-PilotCore and PilotCore-to-PilotUI traffic.
- Improved startup COM restore by parsing framed PilotCore/PilotUI status payloads that pair COM indexes with VHF frequencies.
- Improved flight plan status detection from direct FSD flight-plan lines and IVAO flight-plan replies.
- Improved webapp heartbeat recovery by resynchronizing status on every pong and timing out stuck WebSocket connects.
- Hardened standby/focus recovery by reconnecting stale control WebSockets.
- Added allowlisted CORS support for relay `/health` so hosted webapps can run the remote preflight.
- Fixed the hosted Remote Preview first-run flow so fresh browsers can open Remote settings instead of being blocked by the missing relay-token overlay.
- Fixed remote disconnect overlays so iOS/Safari users can always reopen Remote settings instead of being trapped before pairing.
- Clarified that pairing-code renewal is available from the local Contrail webapp, not from an unpaired remote browser.
- Fixed remote XPDR synchronization by including squawk and mode in agent status updates.
- Fixed repeated COM tuning retries by always sending user-initiated tune commands, even when the browser already displays the requested frequency.
- Prevented remote TX from opening the microphone when Web TX is not ready, and added compact remote TX start/stop PCM counters for live diagnostics.
- Cleared stale Web TX readiness when TS2 UDP sessions close, error, or are
  recreated, so TX does not remain apparently active while packets go to an old
  voice route.
- Improved Remote RX recovery per browser by resynchronizing stale audio queues and unlocking audio output on user interaction.
- Improved Remote Preview agent selection so a browser with a stale saved device id reselects the currently online agent automatically.
- Added compact Web TX encoder and TS2 packet counters so Remote TX tests show whether PCM becomes Speex and leaves the proxy.
- Filtered TS2 RX decoding to voice subtype packets only, avoiding ffmpeg Speex errors from UNICOM/channel-control packets.
- Added `voiceDiagnostics` so voice RX/TX counters can be enabled only during troubleshooting.
- Added gated TS2 TCP/UDP session diagnostics to investigate deriving the Web
  TX seed from voice login/join traffic instead of requiring a real PTT press.
- Added Web TX seed derivation from TS2 setup packets, making the real Altitude
  PTT press a fallback instead of the primary readiness path.

### Known Limitations

- Remote TX audio over the relay is implemented as preview routing and has successful live IVAO listener validation, but it still needs broader validation across more networks/listeners.
- Web TX needs a cached or derived TS2 transmit session after a proxy restart.
  It now derives the seed from TS2 setup when possible; pressing the real
  Altitude PTT once remains the fallback.
- Web TX may have a slight crackle compared with native Altitude TX.
- IVAO does not echo the user's own TX audio, so final TX confirmation requires another listener.
- Message history is intentionally in memory and does not survive a full proxy restart.
- The relay includes SQLite hosted-account preview support, but it is not a production hosted account system yet.
- The proxy is designed to run locally and must not be exposed directly to the public internet.
- ffmpeg must be installed separately and available to the Node process.
- Full Altitude/IVAO integration tests are not yet present.
