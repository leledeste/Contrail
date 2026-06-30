# Contrail Relay

Status: early skeleton with private self-host preview files. It is not ready
for production or untrusted public relay use.

The relay will eventually let remote browsers connect to the Contrail agent running on the PC with IVAO Altitude.

Current capabilities:

- `GET /health` healthcheck.
- CORS headers for allowlisted webapp origins on the healthcheck.
- `GET /ws` WebSocket endpoint.
- Origin allowlist.
- Token gate with optional per-user token scopes.
- Optional SQLite-backed token auth with `.env` fallback or SQLite-only
  mode.
- Optional SQLite-backed account registration/login for hosted browser
  sessions. Logged-in browsers can use their HttpOnly session cookie instead of
  manually pasting a relay token.
- Minimal `/admin` panel and API for SQLite relay user/token management.
- Shared protocol validation through `packages/protocol`.
- In-memory agent registration with `agent.hello`.
- Short-lived browser pairing codes.
- Persistent hashed browser pairing authorizations.
- Browser agent discovery through `device.list` after pairing or account login.
- Browser agent selection through `device.select` after pairing or account login.
- Allowlisted browser-to-agent routing for paired or logged-in account browsers.
- Allowlisted agent-to-browser updates for browsers watching that device.
- Live binary PCM forwarding for Remote RX audio from agent to selected paired browsers.
- Live binary PCM forwarding for Remote TX audio from selected paired browsers to the agent during an active TX session.
- Preview multi-user isolation through `CONTRAIL_RELAY_USERS`, where each token can see only its own agents, pairings, commands, and audio.
- Relay identity messages so browsers and agents can display which token user scope they are connected as.
- Safe errors for validated but not-yet-routed messages.

Not implemented yet:

- Production multi-admin dashboard and browser session management.
- Production deployment hardening.

## Current Routing

The relay is not a raw tunnel. In manual token mode, a browser must pair with
an online agent before commands can be forwarded. In hosted account mode, a
logged-in browser session may select agents owned by the same account without a
pairing code. Only allowlisted message types from `packages/protocol` are
routed.

Browser to agent:

- `radio.set`
- `chat.send`
- `weather.request`
- `atis.request`
- `xpdr.setSquawk`
- `xpdr.setMode`
- `xpdr.ident`
- `tx.start`
- `tx.stop`
- `monitor.start`
- `monitor.stop`

Agent to selected browsers:

- `agent.status`
- `radio.state`
- `stations.state`
- `chat.message`

Messages are forwarded as validated protocol envelopes. Pairing codes are
short-lived and in memory for manual-token browsers. Paired-browser
authorizations can be persisted as hashed browser ids plus agent ids for the
preview. Hosted account sessions instead authorize browsers by the logged-in
SQLite user scope.

Remote audio is live-only in this preview. RX PCM flows from the agent to paired
browsers. TX PCM flows from a paired browser to the selected agent only after a
validated `tx.start` command and only until `tx.stop`, disconnect, device
switch, revocation, or timeout. Browser TX frames must start with the `CTX1`
prefix before the relay strips it and forwards raw PCM to the agent. Audio is
live-only, is never cached, and only keeps a per-frame size guard to reject
malformed oversized frames.

## Development Run

The quickest repeatable setup is to copy the example environment file:

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
```

Edit `apps\relay\.env`, change `CONTRAIL_RELAY_TOKEN`, then run:

```powershell
npm run relay:env
```

Use a long hex token when possible. On Linux/macOS, generate one with:

```bash
openssl rand -hex 32
```

Hex tokens avoid manual URL escaping problems with characters such as `+`, `/`,
and `=` during Remote Preview tests.

The relay refuses to start without either `CONTRAIL_RELAY_TOKEN`,
`CONTRAIL_RELAY_USERS`, active SQLite users, or a SQLite bootstrap path through
`CONTRAIL_RELAY_ADMIN_TOKEN` / `CONTRAIL_RELAY_ENABLE_REGISTRATION`. This keeps
complete tokens out of startup logs and makes accidental public exposure easier
to spot while still allowing a fresh SQLite deployment to create its first
user.

For multiple independent users on the same private relay, use
`CONTRAIL_RELAY_USERS`:

```env
CONTRAIL_RELAY_USERS=daniele=hex-token-1,second_user=hex-token-2
```

Each token creates a separate relay user scope. A browser or agent connected
with one user's token cannot see, pair with, command, or receive audio from
another user's agents. This is not a full account system; it is the first
preview isolation layer before production login/dashboard work. The relay also
sends a `relay.identity` message after connection so clients can show which
scope the current token selected.

The helper below edits an existing `.env` file and generates safe 32-byte hex
tokens:

```powershell
npm.cmd run relay:user -- add daniele --env apps/relay/.env
npm.cmd run relay:user -- rotate daniele --env apps/relay/.env
npm.cmd run relay:user -- remove daniele --env apps/relay/.env
npm.cmd run relay:user -- list --env apps/relay/.env
```

`add` and `rotate` print the new token once. Put that token in the user's local
`config.json` and in the hosted webapp Remote settings, then restart the relay.
If a token is lost, rotate it; the old token stops working after the relay
restarts. There is no recovery path for old tokens, by design.

To prepare the SQLite-backed dashboard/auth flow, import the same `.env` users
into a database:

```powershell
npm.cmd run relay:db:import-users -- --env apps/relay/.env --db .contrail-relay/contrail.db --list
```

By default this only prepares DB records; relay authentication still uses
`.env`. To test DB auth while keeping the `.env` fallback, set:

```env
CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback
CONTRAIL_RELAY_DATABASE=.contrail-relay/contrail.db
```

After confirming the imported DB tokens work, `sqlite` disables the `.env`
fallback:

```env
CONTRAIL_RELAY_AUTH_MODE=sqlite
```

Use SQLite-only mode only after saving a working token. If a displayed token is lost,
rotate/import that user again and restart the relay.

### Relay Authentication Modes

Contrail currently supports three relay token-auth modes through
`CONTRAIL_RELAY_AUTH_MODE`. They are meant to make the migration gradual: start
with `.env`, import the same tokens into SQLite, test SQLite with fallback,
then move to SQLite-only mode when the database flow is trusted.

| Mode | Setting | What authenticates clients | Advantages | Tradeoffs |
| --- | --- | --- | --- | --- |
| `.env` only | `CONTRAIL_RELAY_AUTH_MODE=env` | `CONTRAIL_RELAY_TOKEN` and `CONTRAIL_RELAY_USERS` | Simplest setup, easy to understand, avoids opening SQLite at relay startup, good for one private relay owner. | Every user/token change requires editing `.env` and restarting the relay; no dashboard-friendly token records; weak fit for many users. |
| SQLite with fallback | `CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback` | Active SQLite `agent_tokens`, plus `.env` tokens as fallback | Safest migration mode; imported DB tokens can be tested without locking yourself out; existing deployments keep working while the database is introduced. | Two token sources exist at the same time, so cleanup discipline matters; a token left in `.env` remains valid until removed and the relay is restarted. |
| SQLite only | `CONTRAIL_RELAY_AUTH_MODE=sqlite` | Active SQLite `agent_tokens` only | Cleanest long-term self-host mode; one token source; ready for an admin dashboard, audit trail, token rotation, and later browser/session management. | Requires the database file to be present and backed up; a lost token must be rotated through the DB/import/dashboard path; not ideal until the DB workflow is proven. |

Recommended path:

1. Run `.env` only while setting up the relay.
2. Import users with `npm run relay:db:import-users`.
3. Set `CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback` and verify that DB tokens connect.
4. Remove stale `.env` tokens or keep only an intentional break-glass token.
5. Set `CONTRAIL_RELAY_AUTH_MODE=sqlite` when the SQLite workflow is
   reliable.

For direct SQLite user/token management without editing `.env`, use:

```powershell
npm.cmd run relay:db:user -- list --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- add daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- rotate daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- revoke daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- disable daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- enable daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- delete daniele --db .contrail-relay/contrail.db
npm.cmd run relay:db:user -- backup .contrail-relay/backup.db --db .contrail-relay/contrail.db
```

`add` and `rotate` print the new token once. `revoke` invalidates active tokens
for that user. `disable` keeps the user record but prevents active SQLite
tokens from authenticating. `delete` permanently removes the user and its
tokens from SQLite. Restart already-running relay processes after token, user,
or auth-mode changes.

### Admin Panel

The relay can serve a minimal SQLite admin panel:

```text
http://127.0.0.1:8787/admin
https://relay.example.com/admin
```

Enable it with a separate admin token:

```env
CONTRAIL_RELAY_ADMIN_TOKEN=hex-token-from-openssl-rand-hex-32
```

The admin token is sent as a bearer token to `/admin/api/*`; it is not a relay
user token and should be different from every token used by browsers or local
agents. The page stores the admin token in that browser's local storage for
convenience during preview testing.

The panel currently supports:

- List SQLite users.
- Create a user and show the generated token once.
- Rotate a user's token and show the generated token once.
- Revoke active tokens for a user.
- Disable or enable a user.
- Delete a user permanently.
- List known relay agents/devices and show which ones are online.
- List active browser pairings.
- Revoke an active browser pairing from the admin panel.
- Show a minimal audit log for admin actions, agent connections, and pairing
  create/revoke events.

The panel is intentionally unavailable for user management when
`CONTRAIL_RELAY_AUTH_MODE=env`, because that mode is the simple no-database
path. Use `sqlite-fallback` or `sqlite` to manage users from the admin panel.

### Hosted Account Preview

For a hosted webapp that should not ask users to paste relay tokens into the
browser, use a SQLite mode and enable registration:

```env
CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback
CONTRAIL_RELAY_ENABLE_REGISTRATION=true
CONTRAIL_RELAY_ADMIN_TOKEN=hex-token-from-openssl-rand-hex-32
```

The browser calls `/account/api/register` or `/account/api/login` and receives
an HttpOnly session cookie. Registration creates a user and a one-time agent
token. The user copies that agent token into the local proxy `config.json` as
`remoteRelayToken`; after the proxy connects, logged-in browsers for the same
account can see and select that agent without a pairing code.

The token is not recoverable from the database. If it is lost, rotate it from
the webapp account controls or from `/admin`, then update `config.json`.

If PowerShell blocks `npm`, use:

```powershell
npm.cmd run relay:env
```

You can also set environment variables manually:

```powershell
$env:CONTRAIL_RELAY_TOKEN="hex-token-from-openssl-rand-hex-32"
npm run relay
```

Default bind address:

```text
127.0.0.1:8787
```

This default is intentional. For the private HTTPS/WSS self-host preview, use
the Docker Compose files in `infra/docker`; they bind the relay inside Docker
and expose it through Caddy instead of exposing the Node process directly.

For the local remote-preview test, the default origin allowlist accepts both the
relay origin and the local proxy webapp origin:

```text
http://localhost:3000
http://127.0.0.1:3000
http://localhost:8787
http://127.0.0.1:8787
```

Override this with `CONTRAIL_ALLOWED_ORIGINS` when testing a hosted webapp.

## Docker Self-Host Preview

The VPS preview lives in `infra/docker` and is documented in
[`docs/SELF_HOSTING.md`](../../docs/SELF_HOSTING.md).

It provides:

- Docker Compose.
- A relay container.
- Hosted static webapp serving.
- Caddy HTTPS/WSS reverse proxy.
- A persisted relay data volume for SQLite data and, in `env` mode, JSON
  pairing authorizations.

This is suitable for private preview testing with a trusted relay token and
pairing enabled. It is not a complete hosted account system.

## Environment File

`npm run relay:env` loads `apps/relay/.env` before starting the relay. The file
is intentionally local and ignored by git. Keep `apps/relay/.env.example` in the
repo as the documented template.

Supported preview variables:

```env
CONTRAIL_RELAY_HOST=127.0.0.1
CONTRAIL_RELAY_PORT=8787
CONTRAIL_RELAY_TOKEN=hex-token-from-openssl-rand-hex-32
# CONTRAIL_RELAY_USERS=daniele=hex-token-1,second_user=hex-token-2
CONTRAIL_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
CONTRAIL_RELAY_REQUIRE_PAIRING=true
CONTRAIL_PAIRING_TTL_MS=600000
CONTRAIL_RELAY_PERSIST_PAIRINGS=true
CONTRAIL_RELAY_DATA_DIR=.contrail-relay
CONTRAIL_RELAY_PAIRINGS_FILE=.contrail-relay/pairings.json
CONTRAIL_RELAY_AUTH_MODE=env
CONTRAIL_RELAY_DATABASE=.contrail-relay/contrail.db
# CONTRAIL_RELAY_ADMIN_TOKEN=hex-token-from-openssl-rand-hex-32
CONTRAIL_RELAY_MAX_CLIENTS=100
CONTRAIL_RELAY_RATE_WINDOW_MS=10000
CONTRAIL_RELAY_MAX_MESSAGES_PER_WINDOW=240
CONTRAIL_RELAY_MAX_COMMANDS_PER_WINDOW=80
CONTRAIL_RELAY_MAX_PAIRING_ATTEMPTS_PER_WINDOW=10
CONTRAIL_RELAY_MAX_AUDIO_FRAME_BYTES=32768
CONTRAIL_RELAY_MAX_REMOTE_TX_DURATION_MS=120000
```

The command rate-limit values are per WebSocket connection and are intentionally
simple. They are preview safety limits, not a replacement for production
account-level abuse controls. Live audio is not rate-limited by frame count or
byte count, and TX start/stop are not counted as generic remote commands; only
individual oversized frames and overlong TX sessions are rejected.

## WebSocket URL

```text
ws://127.0.0.1:8787/ws?source=browser&token=hex-token-from-openssl-rand-hex-32
```

Preview relay WebSocket clients may use only these `source` values:

- `browser`
- `agent`

In production, token handling should move to the final auth/session design. Query tokens are acceptable only for this local development skeleton.

## Pairing Preview

When an agent connects, the local proxy asks the relay for a short-lived
pairing code. The relay sends that code back to the agent, then the local proxy
prints it in the console and forwards it to the local webapp.
The local proxy can ask for a fresh code later by sending `pairing.begin` again;
the relay replaces any still-open code for that agent without requiring a proxy
restart.

In the remote webapp, enter that code in `Settings > Remote > Pairing Code` and
press `Pair Browser`. The relay then authorizes that browser id to control the
agent. The browser can revoke its own pairing with `Forget Pairing`.

Environment options:

```env
CONTRAIL_RELAY_REQUIRE_PAIRING=true
CONTRAIL_PAIRING_TTL_MS=600000
CONTRAIL_RELAY_PERSIST_PAIRINGS=true
CONTRAIL_RELAY_DATA_DIR=.contrail-relay
CONTRAIL_RELAY_PAIRINGS_FILE=.contrail-relay/pairings.json
```

Pairing codes are deliberately in memory. Browser authorizations are persisted
as hashed browser ids plus agent ids so a relay restart does not force every
browser to pair again. In `CONTRAIL_RELAY_AUTH_MODE=env`, the relay uses
`CONTRAIL_RELAY_PAIRINGS_FILE`; in `sqlite-fallback` and `sqlite`, active
browser pairings are stored in SQLite and can be listed or revoked from
`/admin`.

This is not a full hosted account system and does not replace production
browser sessions or audit logging.
