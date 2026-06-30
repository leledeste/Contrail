# Contrail Developer Notes

Normal usage is covered in [README](../README.md).

## Local Verification

Run:

```bash
npm run verify
```

On Windows PowerShell, if `npm.ps1` is blocked by execution policy, use:

```powershell
npm.cmd run verify
```

The verification runner validates required project files, JSON files, the local
proxy modules, relay scripts, protocol package, webapp asset references, and
browser/admin JavaScript syntax.

It is a local self-test only. It does not check GitHub for newer versions, download updates, start IVAO Altitude, or test live network voice.

`npm run check` is kept as an alias for `npm run verify`.

## Relay Database Helpers

```bash
npm run db:test
npm run db:auth:test
npm run db:user:test
npm run relay:admin:test
```

These tests validate the SQLite migration layer, relay token authentication
modes, the SQLite user-management CLI, persisted browser pairings, minimal
audit events, and the protected relay admin API.

For manual SQLite relay user management:

```bash
npm run relay:db:user -- list --db .contrail-relay/contrail.db
npm run relay:db:user -- add daniele --db .contrail-relay/contrail.db
npm run relay:db:user -- rotate daniele --db .contrail-relay/contrail.db
npm run relay:db:user -- delete daniele --db .contrail-relay/contrail.db
```

For the browser admin panel, start the relay with
`CONTRAIL_RELAY_ADMIN_TOKEN` set and open:

```text
http://127.0.0.1:8787/admin
```

## Webapp Recovery

The webapp sends heartbeat `ping` commands to the proxy and expects `pong` replies. If the control WebSocket becomes stale, the browser can recover without a full page refresh.

Recovery resets browser audio scheduling and recreates the control WebSocket. It does not restart the proxy and does not touch the TS2 voice codec settings.

## Voice RX

Incoming IVAO voice is received as TS2 UDP traffic and decoded with ffmpeg.

Current RX profile:

```text
TS2 class: 0xbef3
Payload offset: 22
Sample rate: 32000 Hz
Strip bytes: 1
Frames per packet: 12
```

### Voice Diagnostics

Voice diagnostics are disabled by default to keep normal console output quiet.
Enable them temporarily in `config.json` when investigating RX/TX behavior:

```json
{
  "voiceDiagnostics": true
}
```

Useful diagnostic lines:

- `[VOICE RX] packets=... speex=... pcmChunks=... pcm=...` means TS2 RX voice
  packets reached the proxy and ffmpeg produced browser PCM.
- `[REMOTE TX] ... frames=... bytes=... rejected=...` means a remote browser
  sent microphone PCM through the relay to the local agent.
- `[WEBTX] ... speexPackets=... sent=... failed=...` means Web TX encoded PCM
  with ffmpeg and sent TS2-shaped voice packets through the cached Altitude
  transmit session.
- `[TS2 TCP] ...` samples the initial TCP login/join stream between Altitude
  and the real TS2 server.
- `[TS2 UDP] ... kind=setup` samples non-voice UDP setup/control packets.
- `[TS2 UDP] ... kind=voice` samples only the first few voice-like UDP packets
  in each direction, including native Altitude TX packets.

Turn diagnostics back off after testing unless you need live troubleshooting.

### TS2 Session Investigation

Web TX can now derive the TS2 transmit header from voice-channel join/setup
traffic. A native Altitude UDP TX packet still replaces the derived seed when it
appears, because it is the exact server-accepted shape for that session.

Use this workflow when investigating that path:

1. Set `"voiceDiagnostics": true` in `config.json`.
2. Start Contrail and connect Altitude normally.
3. Join a voice-capable frequency, but do not press PTT yet.
4. Save the `[TS2 TCP]` and `[TS2 UDP] ... kind=setup` lines printed during the
   join.
5. Press the real Altitude PTT once for a short native TX.
6. Compare the first `[TS2 UDP] ... client->server ... kind=voice` packet with
   the earlier setup lines.

The most useful fields are:

```text
class/subtype
h4_11
h12_19
h16_23
seq
head
```

If Web TX fails before a physical PTT but works after it, compare the derived
setup session bytes with the first native TX packet. These logs can include
session identifiers and callsigns, so do not publish them unredacted.

## Voice TX

Web TX uses the browser microphone, encodes it with ffmpeg/libspeex, and sends it through the cached Altitude TS2 transmit session.

Current TX profile:

```text
TS2 class: 0xbef2
Packet size: 325 bytes
Payload size: 309 bytes
Payload shape: 0x05 + 308 Speex bytes
Sample rate: 8000 Hz
Speex quality: 10
Frames per packet: 5
Packet interval: configured in config.json
```

After a fresh proxy restart, join a voice-capable station so Contrail can derive the TS2 transmit session. If Web TX does not become ready, press the real Altitude PTT once as a fallback.

## TX Monitor

The `Monitor TX` button in the webapp plays your encoded microphone audio back locally. It is useful for checking browser microphone permission, gain, and local encoding.

It does not transmit to IVAO.
