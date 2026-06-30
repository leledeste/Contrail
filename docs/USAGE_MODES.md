# Contrail Usage Modes

Contrail currently ships as one source repository, but it is useful to think in
three usage modes. This keeps the project understandable now and gives the
future packaging work a clear shape.

## Local User Mode

Use this when you only want Contrail beside IVAO Altitude on your simulator PC.

What you run:

- `proxy.js`
- the bundled `webapp`
- your local `config.json`

What you do not need:

- Docker
- Caddy
- a VPS
- relay admin tools
- SQLite account administration unless you use a hosted relay

Typical flow:

1. Install Node.js and ffmpeg.
2. Configure `config.json`.
3. Start Contrail with `npm start` or `start.bat`.
4. Point PilotUI / Altitude to the Simulator Address printed by Contrail.
5. Open `http://localhost:3000`.

This is the lightest future download target: **Contrail Local**.

## Hosted Browser Mode

Use this when the proxy still runs on your simulator PC, but the browser UI is
served from a public HTTPS domain such as `https://app.example.com`.

What you run locally:

- `proxy.js` with `remoteAgentEnabled: true`
- a `remoteRelayUrl`
- an account agent token or a manual relay token

What the browser uses:

- hosted static webapp
- relay WebSocket
- either account login or manual token plus pairing code

For account mode, the hosted webapp opens on Login / Register. Registration
shows a one-time agent token that must be copied into the local `config.json`.
Logged-in browsers for the same account can control that account's online
agent without a browser pairing code.

For manual token mode, choose `Manual Relay Setup` on the first screen and enter
relay URL, relay token, and pairing code in `Settings > Remote`.

### Phone As IVAO Microphone

This mode also covers a practical cockpit setup where the simulator PC has no
microphone, or the user prefers a headset connected to a phone or tablet.

In that setup:

- Altitude, PilotCore, and the Contrail proxy keep running on the simulator PC.
- The phone opens the hosted Contrail webapp over HTTPS.
- The phone browser receives remote RX audio and sends microphone PCM back to
  the local agent over WSS.
- The local agent encodes that microphone audio with the same Web TX path used
  by the local webapp, then sends it to IVAO through the cached TS2 transmit
  session.

The relay never replaces the local proxy. It only carries authenticated browser
control and live audio between the phone and the user's own PC.

## Self-Hosted Server Mode

Use this when you want to run your own relay and hosted webapp.

What you run on the server:

- `apps/relay`
- static `webapp`
- Docker Compose files in `infra/docker`
- Caddy HTTPS/WSS reverse proxy
- optional SQLite database for accounts, agent tokens, sessions, pairings, and audit events

What you still keep local:

- the proxy beside Altitude
- all IVAO-facing sockets
- ffmpeg voice encode/decode

The local proxy must not be exposed directly to the internet. Only the relay and
static webapp belong on the public server.

This is the future download target: **Contrail Server**.

## Developer / Full Source Mode

Use this when you want to modify Contrail itself.

What you need:

- the full repository
- Node.js and npm
- ffmpeg
- test commands such as `npm run verify`, `npm run remote:test`, and
  `npm run relay:account:test`

This mode includes local proxy code, webapp code, relay code, documentation,
tests, Docker files, and project design notes.

This is the future download target: **Contrail Full Source**.

## Packaging Direction

The project should avoid maintaining separate codebases. The preferred future
shape is one repository with separate release artifacts for different users:

- **Contrail Local**: minimal local proxy package for normal pilots. It should
  include the local agent/proxy, local webapp, start scripts, and config
  examples, but not the relay admin stack.
- **Contrail Hosted Webapp**: static webapp artifact for an official, community,
  or private HTTPS host.
- **Contrail Server**: relay, hosted webapp, Docker/Caddy files, SQLite/admin
  tools, and server docs for self-hosting.
- **Contrail Full Source**: complete repository for contributors, auditors, and
  advanced self-hosters who want every component and test.
