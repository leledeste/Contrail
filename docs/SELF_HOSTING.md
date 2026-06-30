# Self-Hosting Contrail Remote

Status: preview infrastructure. The relay can be self-hosted with Docker Compose
and Caddy for HTTPS/WSS, but this is still a Remote Preview. SQLite hosted
accounts and the admin panel are available as preview features; production-grade
authorization, revocation, and hardened audio are not complete yet.

Contrail Remote should stay self-hostable so users can avoid depending on an
official relay. A self-hosted deployment serves the static webapp and receives
only outbound connections from the local Contrail agent plus authenticated
browser connections from trusted devices. The local proxy ports for
PilotUI/PilotCore, FSD, and TS2 must never be exposed directly to the internet.

## Current Deployment Shape

```text
Remote browser / phone
        |
        | HTTPS + WSS
        v
Caddy on a VPS
        |
        +-- Static Contrail webapp
        +-- Contrail Relay container
        ^
        | WSS outbound
        |
Contrail proxy on the PC running Altitude
```

The relay forwards typed, allowlisted commands between the browser and the local
agent. It does not store IVAO credentials, raw IVAO traffic, chat history, or
voice audio.

## Minimum Requirements

- Domain names, for example `app.example.com` and `relay.example.com`.
- A VPS or server reachable from the internet.
- Docker and Docker Compose on that server.
- DNS `A` or `AAAA` records pointing the relay domain to the server.
- Ports `80` and `443` open on the server firewall.
- A long random relay token shared by the local proxy and your trusted browsers,
  or one token per independent user when using the multi-user preview.

## Docker Preview Files

The self-host preview files live in:

```text
infra/
  docker/
    docker-compose.yml
    relay.Dockerfile
    Caddyfile
    .env.example
```

`docker-compose.yml` starts:

- `contrail-relay`: the Node.js relay.
- `caddy`: HTTPS/WSS reverse proxy with automatic certificates and static
  webapp serving.

The relay data volume persists the SQLite database and, when using `env` auth
mode, the JSON pairing store. Paired browsers can survive a relay container
restart when `CONTRAIL_RELAY_PERSIST_PAIRINGS=true`.

The relay image uses Debian slim instead of Alpine because SQLite support uses
the native `better-sqlite3` package. The Dockerfile builds native dependencies
in a builder stage so the VPS does not need Python or compilers installed on
the host.

## First VPS Setup

Clone or copy the Contrail repository to the server, then create the relay
environment file:

```bash
cp infra/docker/.env.example infra/docker/.env
```

Edit `infra/docker/.env`:

```env
WEBAPP_DOMAIN=app.example.com
RELAY_DOMAIN=relay.example.com
CADDY_ACME_EMAIL=you@example.com
CONTRAIL_RELAY_TOKEN=hex-token-from-openssl-rand-hex-32
# Optional multi-user preview:
# CONTRAIL_RELAY_USERS=daniele=hex-token-1,second_user=hex-token-2
CONTRAIL_ALLOWED_ORIGINS=https://app.example.com,https://relay.example.com
CONTRAIL_RELAY_REQUIRE_PAIRING=true
CONTRAIL_RELAY_PERSIST_PAIRINGS=true
CONTRAIL_RELAY_AUTH_MODE=env
CONTRAIL_RELAY_DATABASE=/var/lib/contrail-relay/contrail.db
# Optional SQLite admin panel:
# CONTRAIL_RELAY_ADMIN_TOKEN=hex-token-from-openssl-rand-hex-32
# Optional hosted account registration. Requires sqlite-fallback or sqlite:
CONTRAIL_RELAY_ENABLE_REGISTRATION=false
```

Generate the token on the VPS with:

```bash
openssl rand -hex 32
```

Hex tokens are recommended because they avoid URL escaping problems with
characters such as `+`, `/`, and `=` during manual Remote Preview testing. If
you enable the admin panel, generate a separate admin token; do not reuse a
relay user token.

If one relay should serve multiple independent users, set
`CONTRAIL_RELAY_USERS` with comma-separated `user_id=token` entries. A proxy and
browser using one user's token cannot see, pair with, command, or receive audio
from another user's agents. This is isolation for private preview use, not a
full account/login system.

You do not have to edit that line by hand every time. From a checkout of the
repository, the relay user helper can update an existing `.env` file:

```bash
npm run relay:user -- add daniele --env infra/docker/.env
npm run relay:user -- rotate daniele --env infra/docker/.env
npm run relay:user -- remove daniele --env infra/docker/.env
npm run relay:user -- list --env infra/docker/.env
```

`add` and `rotate` print the new token once. Save it in the user's local
`config.json` and in that user's hosted webapp Remote settings. Restart the
relay stack after changing `.env`:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d
```

If a token is lost before it is saved, rotate that user. The old token remains
valid only until the relay is restarted with the updated `.env`.

To prepare SQLite-backed relay authentication, import the same `.env` users
into a database:

```bash
npm run relay:db:import-users -- --env infra/docker/.env --db ./contrail.db --list
```

For Docker deployments, run the import wherever the relay database file is
mounted or reachable. The recommended Docker path is:

```bash
/var/lib/contrail-relay/contrail.db
```

Set `CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback` to let the relay accept SQLite
tokens while still keeping the `.env` fallback. After confirming the imported
tokens work, set `CONTRAIL_RELAY_AUTH_MODE=sqlite` to use SQLite only.

### Choosing A Relay Auth Mode

Use this rule of thumb for self-hosting:

| Mode | Best For | Main Benefit | Main Risk |
| --- | --- | --- | --- |
| `.env` only (`env`) | First setup, one owner, private testing. | Few moving parts, SQLite is not opened at relay startup, and recovery is just editing one file. | Manual edits and restarts do not scale well for multiple users. |
| SQLite with fallback (`sqlite-fallback`) | Migration from `.env` to database tokens. | You can test DB tokens while old `.env` tokens still work. | Leaving old `.env` tokens in place means they remain valid. |
| SQLite only (`sqlite`) | Stable self-hosted relay with multiple users. | One source of truth, better fit for future dashboard and audit tools. | The database must be backed up and reachable before the relay starts. |

For a new VPS, start with `.env` only until the relay works. Then import users
into SQLite and use fallback mode for a short test period. Use SQLite-only mode
only after at least one DB token has successfully connected as both local agent
and remote browser.

When using `sqlite-fallback` or `sqlite`, manage users directly in the database:

```bash
npm run relay:db:user -- list --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- add daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- rotate daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- revoke daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- disable daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- enable daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- delete daniele --db /var/lib/contrail-relay/contrail.db
npm run relay:db:user -- backup /root/contrail-relay-backup.db --db /var/lib/contrail-relay/contrail.db
```

The token printed by `add` or `rotate` is shown once. Save it in the user's
local proxy `config.json` and hosted webapp Remote settings before closing the
terminal.

The same SQLite user operations are also available from the relay admin panel:

```text
https://relay.example.com/admin
```

Set `CONTRAIL_RELAY_ADMIN_TOKEN` before opening the panel. The panel is useful
for SQLite modes only; in `env` mode it reports that SQLite admin is disabled.
It can list users, create users, rotate/revoke tokens, disable/enable users,
permanently delete users, list known devices, list active browser pairings, and
revoke browser pairings. It also shows recent security/control audit events for
admin actions, agent connections, and pairing changes. It is still a preview
admin surface, not a full hosted account system.

### Hosted Account Registration

For a hosted webapp where users should log in instead of pasting relay tokens
into the browser, use SQLite auth and enable registration:

```env
CONTRAIL_RELAY_AUTH_MODE=sqlite-fallback
CONTRAIL_RELAY_ENABLE_REGISTRATION=true
CONTRAIL_RELAY_ADMIN_TOKEN=hex-token-from-openssl-rand-hex-32
```

The account flow is:

1. The user opens `https://app.example.com`.
2. The first hosted screen lets the user register or log in.
3. Registration shows a one-time agent token.
4. The user copies that token into local `config.json` as `remoteRelayToken`.
5. The local proxy connects as that account's agent.
6. Logged-in browsers can see/select the account's online agent without a
   pairing code.

The agent token is still needed locally because the proxy needs a secret to
prove ownership of the PC. Tokens are stored hashed in SQLite and are shown
only when created or rotated.

Use exact origins in `CONTRAIL_ALLOWED_ORIGINS`. If your webapp is hosted at
`https://app.example.com`, add that exact origin. If you only test from the relay
domain, include `https://relay.example.com`.

Start the relay stack:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d --build
```

Check the relay health endpoint:

```text
https://relay.example.com/health
```

Expected response:

```json
{"ok":true,"service":"contrail-relay","clients":0,"devices":0}
```

Check the hosted webapp:

```text
https://app.example.com/
```

Because this is a public HTTPS host, the webapp opens in Remote Preview mode by
default. If needed, `https://app.example.com/?remote=1` is also valid.

## Local Proxy Configuration

On the PC running Altitude, configure `config.json` with the self-hosted relay:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "wss://relay.example.com",
  "remoteRelayToken": "hex-token-from-openssl-rand-hex-32"
}
```

The token must match `CONTRAIL_RELAY_TOKEN` or one entry in
`CONTRAIL_RELAY_USERS` in `infra/docker/.env`.

Start Contrail locally and verify that the proxy prints a remote pairing code.
The local proxy still talks to Altitude, FSD, and TS2 only on the local PC.

## Remote Browser Configuration

Open the hosted webapp:

```text
https://app.example.com/
```

If SQLite account registration/login is enabled, the hosted webapp opens on the
Contrail Remote login/register screen. Log in or register there; no relay token
or browser pairing code is needed for browsers authenticated to the same
account as the local agent.

For manual token-mode testing, press `Manual Relay Setup` on the first screen,
then enter these values in `Settings > Remote`:

- Relay URL: `wss://relay.example.com`
- Relay token: the same long relay token, or the specific user token if using
  `CONTRAIL_RELAY_USERS`
- Pairing code: the temporary code printed by the local proxy

Then press `Apply Remote`, `Check Remote`, and `Pair Browser`.

If a browser was previously switched to manual token mode, use
`Settings > Remote > Login / Register` to reopen the account screen.

After the browser connects, `Settings > Remote` shows the relay user scope that
the token selected. If that user value is unexpected, stop and verify the token
before pairing the browser.

`Check Remote` calls `https://relay.example.com/health` from the hosted webapp
origin. If it reports that the health endpoint is blocked, check that
`CONTRAIL_ALLOWED_ORIGINS` includes the exact webapp origin.

## Local Development Relay

For local testing without Docker:

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
npm.cmd run relay:env
```

Edit `apps\relay\.env` before exposing anything outside localhost. At minimum,
change `CONTRAIL_RELAY_TOKEN` and set `CONTRAIL_ALLOWED_ORIGINS` to the exact
webapp origin you trust.

## Backup Guidance

Back up:

- `infra/docker/.env`, stored securely.
- The admin token if `CONTRAIL_RELAY_ADMIN_TOKEN` is configured.
- The SQLite relay database if using `sqlite-fallback` or `sqlite`. The helper
  command is `npm run relay:db:user -- backup output.db --db path/to/contrail.db`.
- Caddy configuration if customized.
- The Docker relay data volume if you want paired browsers to survive rebuilds.

Do not back up:

- Voice audio.
- IVAO raw traffic.
- Chat history.
- Authentication tokens in plaintext outside a secure secret store.

The current preview pairing store, whether JSON or SQLite, contains hashed
browser ids and agent ids, not chat, audio, or raw IVAO traffic.

## Update Guidance

From the repository folder on the VPS, for example `/opt/contrail`, update the
checkout and rebuild the Docker stack:

```bash
cd /opt/contrail
git pull
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d --build
```

If the server has the older standalone Compose binary instead of the Docker
Compose v2 plugin, use:

```bash
cd /opt/contrail
git pull
docker-compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d --build
```

Then check that both containers are running:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env ps
```

Follow logs while testing:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env logs -f
```

Check the public relay health endpoint:

```bash
curl https://relay.example.com/health
```

Expected shape:

```json
{"ok":true,"service":"contrail-relay","clients":0,"devices":0}
```

Open the hosted webapp after the stack is rebuilt:

```text
https://app.example.com/
```

The local PC running Altitude does not need to be on the same network as the
VPS. It only needs `config.json` to point at the relay:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "wss://relay.example.com",
  "remoteRelayToken": "the-current-agent-token"
}
```

Restart the local proxy after changing `config.json`.

### Update Checklist

1. Back up `infra/docker/.env`.
2. If using SQLite auth, back up the database or Docker volume.
3. Run `git pull` on the VPS.
4. Rebuild with `docker compose ... up -d --build`.
5. Check `docker compose ... ps`.
6. Check `https://relay.example.com/health`.
7. Open `https://app.example.com/`.
8. Start the local proxy and confirm the agent connects.
9. Test one browser command, one chat/weather command, and Remote RX audio.

For SQLite deployments, the database lives inside the relay data volume at:

```text
/var/lib/contrail-relay/contrail.db
```

When you run helper commands outside Docker, point them at the mounted or copied
database path. When in doubt, back up from the admin panel or use the helper
before changing auth mode:

```bash
npm run relay:db:user -- backup /root/contrail-relay-backup.db --db /var/lib/contrail-relay/contrail.db
```

If an update fails before containers start, inspect logs first:

```bash
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env logs --tail=200
```

To return to the previous commit in an emergency, use Git normally on the VPS
and rebuild:

```bash
git log --oneline -5
git checkout <previous-commit>
docker compose -f infra/docker/docker-compose.yml --env-file infra/docker/.env up -d --build
```

After the issue is fixed, return to the branch you deploy from, usually:

```bash
git checkout main
git pull
```

## Security Checklist

- Use HTTPS/WSS only.
- Use a long random relay token.
- Keep `CONTRAIL_ALLOWED_ORIGINS` narrow.
- Keep pairing required.
- Keep Docker images and the host operating system updated.
- Restrict SSH access to the server.
- Keep logs out of public web paths.
- Rotate the relay token after suspected compromise.

## Production Gaps

The self-host preview is useful for private testing, but production remote
hosting still needs:

- Real user accounts or another strong authentication model.
- Admin-side device/session revocation.
- Audit logs for security-sensitive actions. The current SQLite audit log
  covers admin user/token actions, agent connect/disconnect, and pairing
  create/revoke events; broader production login/session audit remains future
  work.
- Better abuse limits for public/community relays.
- Broader live audio validation and production hardening for Remote RX/TX forwarding.
