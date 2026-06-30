# Contrail Remote Architecture

Status: planned production architecture with a verified Remote Preview and
private self-host preview files. The local proxy can connect outbound to the
relay as an experimental agent, browsers can pair with that agent for typed
remote control, Remote RX audio works through the relay, and Remote TX audio is
implemented as preview routing. Complete production remote access is not
implemented yet.

Contrail Remote is intended to let a user run Contrail on the PC that has IVAO Altitude, then control it from any network and any trusted device.

The proxy should never be exposed directly to the public internet. Remote access should use a relay that only receives outbound connections from the local agent and authenticated browser connections from the user.

Production authentication, per-user agent tokens, browser sessions, and Shared
Cockpit permissions are detailed in [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md).

## Goals

- Keep the Altitude-facing proxy local to the user's PC.
- Let remote browsers control radio, chat, XPDR, RX, and TX through an authenticated relay.
- Make the relay open source and self-hostable.
- Let users choose the official hosted relay, a community relay, or their own private relay.
- Minimize what the relay can see and store.
- Keep the remote protocol explicit and auditable.

## Non-Goals

- Do not run the Altitude proxy on a public server.
- Do not expose PilotUI/PilotCore, FSD, or TS2 proxy ports directly to the internet.
- Do not store IVAO credentials.
- Do not store IVAO raw traffic, voice audio, or chat history on the relay.
- Do not support arbitrary raw protocol commands over remote access.

## Components

```text
Remote browser / phone
        |
        | HTTPS + WSS
        v
Contrail Relay
        ^
        | WSS outbound from the user's PC
        |
Contrail Agent on the PC with Altitude
        |
        +-- PilotUI / PilotCore
        +-- IVAO FSD
        +-- IVAO TS2 voice
```

### Contrail Agent

The agent is the local proxy that currently exists as `proxy.js`.

It owns:

- PilotUI/PilotCore proxying.
- FSD proxying.
- TS2 voice proxying.
- Local radio/chat/XPDR state.
- Local RX/TX audio handling.
- The outbound remote connection to the relay.

The agent should be the only component that talks to Altitude, FSD, and TS2.

Current foundation:

- `proxy.js` can optionally connect outbound to a relay as `source=agent`.
- The agent announces itself with `agent.hello`.
- The agent accepts allowlisted `radio.set`, `chat.send`, and `xpdr.*`
  messages from the relay and maps them to the existing local functions.
- The agent accepts typed `weather.request` and `atis.request` messages and
  translates them to IVAO/FSD requests locally.
- The agent publishes status, COM state, and chat messages back to the relay.
- The webapp can run in an early remote-browser mode with
  `?remote=1&relay=...&token=...`, auto-select the online agent, and send the
  supported typed commands through the relay.
- Product model: one user normally has one active local agent attached to one
  simulator/Altitude instance, while multiple browsers or phones may control
  that same agent.
- The relay supports short-lived in-memory browser pairing codes and persistent
  hashed paired-browser authorizations. In `env` auth mode the authorization
  store is `pairings.json`; in `sqlite-fallback` and `sqlite` modes it is
  SQLite and can be listed/revoked from `/admin`.
- Verified non-audio controls include pairing, COM, station dropdowns, chat,
  weather/ATIS requests, XPDR squawk/mode, and IDENT.
- Remote RX audio has been confirmed through a self-hosted relay, including
  simultaneous PC and mobile browser playback. Remote TX audio routing is
  implemented as preview routing and has been received by another IVAO user in
  live testing.

### Contrail Relay

The relay is a public HTTPS/WSS service.

It owns:

- User authentication.
- Device pairing.
- Device presence.
- Remote session authorization.
- Message forwarding between a browser and the user's paired agent.
- Security event logging.

The relay should not own:

- IVAO credentials.
- Altitude credentials.
- Raw FSD or TS2 traffic persistence.
- Voice recording.
- Chat persistence.

### Contrail Webapp

The webapp is the user interface.

It can run in three modes:

- `local`: served by the local agent at `http://localhost:3000`.
- `official-remote`: served by the official Contrail deployment.
- `self-hosted-remote`: served by a self-hosted relay or static hosting provider.

The private self-host preview serves the existing static webapp through Caddy
from [infra/docker](../infra/docker). When opened from a public HTTPS host, the webapp defaults
to Remote Preview mode and asks for relay settings instead of attempting to
connect to a local `/ws` proxy.

## Remote Session Flow

1. The user starts the Contrail agent on the Altitude PC.
2. The user enables remote mode.
3. The agent opens a WSS connection to the configured relay.
4. The relay issues a short-lived pairing code to the agent.
5. The user opens the remote webapp from a browser or phone.
6. The browser sends its local browser id and the pairing code to the relay.
7. The relay stores a hash of that browser id and the online agent id.
8. Commands flow browser -> relay -> agent.
9. State updates flow agent -> relay -> paired browsers.

The current preview intentionally persists only hashed browser ids and agent ids.
SQLite relay modes can list and revoke those pairings from `/admin`; `env` mode
keeps the simpler JSON store. The local agent can request a fresh pairing code
without restarting by sending `pairing.begin` again; the relay replaces any
still-open code for that agent. A hosted production version should add user
accounts, persistent browser sessions, fuller device lifecycle management, and
broader login/session audit logging.

## Message Classes

Remote messages should be typed, versioned, and validated.

The first shared protocol rules live in [packages/protocol](../packages/protocol).

Every JSON message uses a versioned envelope:

```json
{
  "v": 1,
  "id": "message-1",
  "type": "radio.set",
  "payload": {
    "com": 1,
    "freq": "128.350"
  }
}
```

Every action must be allowlisted. Remote mode must not expose a generic raw FSD/TS2/PilotCore command channel.

## Audio Direction

### RX

Remote RX currently uses live PCM over the relay for simplicity and low latency.
Compression can be revisited later if bandwidth or relay scale requires it.

Current flow:

```text
Agent receives TS2 voice
Agent decodes it to PCM
Relay forwards bytes
Browser decodes and plays
```

### TX

Remote TX is the highest-risk feature because it controls live microphone
transmission.

Current preview flow:

```text
Browser captures microphone
Browser sends live PCM audio to relay during tx.start
Relay forwards bytes
Agent injects the PCM into the existing local Web TX encoder and TS2 transmit path
```

The relay does not record audio. It enforces selected-agent checks, frame/byte
limits, a `CTX1` browser audio prefix, maximum PTT duration, and stop on
disconnect, revocation, device switch, or timeout.

## Security Boundaries

- Browser-to-relay traffic must use HTTPS/WSS.
- Agent-to-relay traffic must use WSS.
- The relay must authenticate both sides.
- The relay must authorize every browser action against the paired agent.
- The agent must validate every relayed command before touching Altitude.
- Tokens must be revocable.
- Pairing codes must be one-time and short-lived.

## Deployment Shapes

### Official Relay

The project may provide an optional official hosted relay.

Users who want convenience can use it, but the official relay must not be required for remote mode to work.

### Self-Hosted Relay

Users can run their own relay and point both the webapp and local agent to it.

Preview Docker Compose files are available in [infra/docker](../infra/docker). They run the
relay and static webapp behind Caddy, which handles HTTPS/WSS and automatic
certificates. This is intended for private preview testing; production
self-hosting still needs real browser authentication, persistent sessions,
broader structured audit logging, and remote audio decisions.

### Local Only

Local-only mode remains supported and should stay the safest default.
