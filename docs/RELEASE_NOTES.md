# Contrail v0.1.0 Release Notes

Contrail v0.1.0 is the first public release of the local IVAO Altitude bridge and browser control surface.

## Highlights

- Local PilotUI/PilotCore bridge.
- Local FSD proxy for messages, weather replies, ATC station data, and voice announcements.
- Browser webapp for radio tuning, chat, METAR/TAF/ATIS, XPDR, RX voice, and Web TX.
- Remote Preview foundation with typed protocol validation, relay, pairing, command routing, live RX forwarding, and preview TX forwarding.
- Self-host preview files for a relay and static webapp behind Caddy HTTPS/WSS.
- Live self-host testing confirmed Remote RX audio with low perceived latency,
  including PC and mobile browsers listening at the same time. Live Remote TX
  audio was received by another IVAO user.
- GitHub Actions CI for Windows and Linux.
- Local verification commands: `npm run verify` and `npm run remote:test`.

## Known Limitations

- Remote audio is still preview-grade: Remote RX and Remote TX work in initial
  live tests, but need broader validation across more networks, browsers, and
  listeners before production use.
- Web TX needs the real Altitude PTT once after a proxy restart so Contrail can cache the TS2 transmit session.
- Web TX may have a slight crackle compared with native Altitude TX.
- The relay includes SQLite hosted-account preview support, but it is not a production hosted account system yet.
- The proxy must stay local and must not be exposed directly to the public internet.
- ffmpeg must be installed separately and available in `PATH`.

## Verification Before Publishing

Run:

```bash
npm run verify
npm run remote:test
```

On Windows PowerShell:

```powershell
npm.cmd run verify
npm.cmd run remote:test
```
