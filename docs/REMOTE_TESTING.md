# Contrail Remote Preview Testing

Status: development checklist. This verifies the current relay/agent/browser
remote preview, not a production hosted deployment.

This file uses a local relay at `ws://127.0.0.1:8787`. For the VPS HTTPS/WSS
self-host preview, use [SELF_HOSTING.md](SELF_HOSTING.md).

## What This Tests

- Relay starts with explicit environment settings.
- Local proxy connects outbound as the remote agent.
- Browser pairs with the agent through the relay.
- Remote browser can control radio, chat, weather/ATIS requests, and XPDR.
- Remote browser can receive live RX PCM forwarded by the agent through the relay.
- Remote browser can send live TX PCM through the relay to the local agent while TX is active.

Current status: this checklist verifies Remote Preview controls and basic
Remote RX/TX binary forwarding. Live IVAO TX intelligibility still requires a
second listener.

Live status for the v0.1.0 initial release: self-hosted Remote RX tests
confirmed usable audio with low perceived latency, including simultaneous PC
and mobile browser playback. Live IVAO Remote TX was received by another user.
The automated simulation below is still useful because it catches
relay/protocol regressions without Altitude.

## Automated Simulation

Run this first when changing the relay or remote protocol:

```powershell
npm.cmd run remote:test
```

The script starts a temporary relay on `127.0.0.1`, simulates one agent and one
browser, then verifies:

- `/health` and allowlisted CORS.
- Invalid token and blocked origin rejection.
- Browser commands are blocked before pairing.
- Pairing code flow.
- `radio.set`, `chat.send`, `weather.request`, `atis.request`, and `xpdr.*`
  routing from browser to agent.
- `agent.status`, `radio.state`, `stations.state`, and `chat.message` routing
  from agent to selected browser.
- Binary Remote RX PCM forwarding from agent to selected browser.
- Binary Remote TX PCM forwarding from browser to selected agent during `tx.start`.
- Browser-side pairing revocation.

This simulation does not start Altitude or connect to IVAO. Its audio check is
a synthetic binary forwarding check, not a live IVAO voice call.

## Live Voice Diagnostics

For live troubleshooting, temporarily enable:

```json
{
  "voiceDiagnostics": true
}
```

Then restart the local proxy and watch for:

- `[VOICE RX] ... pcm=...` when another station transmits.
- `[REMOTE TX] ... rejected=0` when the remote browser sends microphone PCM.
- `[WEBTX] ... sent=... failed=0` when encoded voice packets leave the proxy.

Disable `voiceDiagnostics` again after the test to keep the console quiet.

## 1. Prepare Relay Settings

```powershell
Copy-Item apps\relay\.env.example apps\relay\.env
```

Edit `apps\relay\.env` and set a real test token:

```env
CONTRAIL_RELAY_TOKEN=hex-token-from-openssl-rand-hex-32
```

Recommended token command:

```bash
openssl rand -hex 32
```

Using a hex token avoids URL escaping issues when manually opening the hosted
webapp with query parameters.

For local testing, keep:

```env
CONTRAIL_RELAY_HOST=127.0.0.1
CONTRAIL_RELAY_PORT=8787
```

## 2. Start The Relay

Use a dedicated terminal:

```powershell
npm.cmd run relay:env
```

Expected output:

```text
[relay] Listening on http://127.0.0.1:8787
[relay] Browser pairing: required
```

The health URL should return JSON:

```text
http://127.0.0.1:8787/health
```

## 3. Configure The Local Agent

In `config.json`, enable remote agent mode and use the same token:

```json
{
  "remoteAgentEnabled": true,
  "remoteRelayUrl": "ws://127.0.0.1:8787",
  "remoteRelayToken": "hex-token-from-openssl-rand-hex-32"
}
```

Keep the rest of your existing config values unchanged.

## 4. Run The Preflight Check

With the relay running, use another terminal:

```powershell
npm.cmd run remote:check
```

This checks:

- `apps/relay/.env` exists.
- `config.json` has remote agent mode enabled.
- Relay token matches between `.env` and `config.json`.
- Relay health endpoint is reachable.

It also prints the exact Relay URL and local remote-preview URL to use.

## 5. Start Contrail

Use your normal startup flow:

```powershell
npm.cmd start
```

or:

```powershell
start.bat
```

Expected remote output in the proxy terminal:

```text
[REMOTE] Agent connected as ...
[REMOTE] Browser pairing code: ABC-123
```

## 6. Pair The Remote Browser

Open:

```text
http://localhost:3000/?remote=1
```

Go to `Settings > Remote` and enter:

```text
Relay URL: ws://127.0.0.1:8787
Relay Token: the full value from apps\relay\.env
Pairing Code: ABC-123
```

Press `Apply Remote`, then `Check Remote`. Press `Pair Browser` if pairing did
not happen during connect.

Expected result:

- `Settings > Remote > Relay Check` shows a healthy relay result.
- `Settings > Remote` shows the agent online.
- The status pill shows Remote Preview.
- COM, chat, weather/ATIS, and XPDR controls can send commands through the relay.

## 7. Functional Checks

Try these in the remote browser:

- Change COM1 or COM2 frequency.
- Select a station from the COM dropdown.
- Send `.metar LIMC` or `.taf LIMC`.
- Change squawk.
- Toggle `STBY` / `ALT`.
- Press `ID`.

The local proxy should receive the remote commands and apply them through the
same local control paths used by the normal webapp.

## 8. Pairing Persistence Check

After pairing:

1. Stop the relay.
2. Start it again with `npm.cmd run relay:env`.
3. Refresh the remote browser.

Expected result:

- The browser should still be authorized because the relay persisted the hashed
  browser pairing. In `env` mode this is stored in
  `.contrail-relay/pairings.json`; in `sqlite-fallback` or `sqlite` mode it is
  stored in the relay SQLite database.

Use `Settings > Remote > Forget Pairing` to revoke this browser's pairing. In
SQLite modes, the same pairing can also be revoked from the relay admin panel.

## Troubleshooting

### `remote:check` says relay health failed

Start the relay first:

```powershell
npm.cmd run relay:env
```

### `remoteRelayToken` mismatch

The token in `config.json` must exactly match `CONTRAIL_RELAY_TOKEN` in
`apps/relay/.env`.

### Agent does not appear online

Check the proxy console for:

```text
[REMOTE] Agent connected as ...
```

If it is missing, check `remoteAgentEnabled`, `remoteRelayUrl`, and
`remoteRelayToken` in `config.json`.

### Browser cannot pair

Pairing codes expire. Copy the latest code printed by the proxy or shown in the
local webapp. If needed, use `Settings > Remote > Renew Pairing Code` in the
local webapp to request a fresh code without restarting the proxy, then use
`Copy Pairing Code` to copy it.

### Commands work locally but not remotely

Radio/chat/weather/ATIS/XPDR should work first. If TX/RX audio does not work,
run `npm.cmd run remote:check`, confirm the relay token and URL, and confirm
the local Web TX status is ready after one real Altitude PTT press.
