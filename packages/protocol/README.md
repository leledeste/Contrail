# Contrail Remote Protocol

Status: first technical foundation for planned remote/self-hosted mode.

This package defines the allowlisted JSON messages shared by the future webapp, relay, and local agent.

The local proxy, relay skeleton, and remote-browser preview use these messages
as the first remote foundation. The goal is to keep remote work on a validated
protocol instead of ad hoc WebSocket payloads.

## Envelope

Every JSON message uses the same envelope:

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

Fields:

- `v`: protocol version.
- `id`: caller-generated message id for tracing and replies.
- `type`: allowlisted message type.
- `payload`: validated object for that type.

## Security Rules

- Unknown message types are rejected.
- Unexpected payload fields are rejected.
- Each message type is bound to an allowed source: browser, agent, or relay.
- Radio frequencies are limited to the normal VHF COM range.
- No remote raw FSD, TS2, or PilotCore command is defined.
- JSON messages are size-limited before parsing.

## Routing Model

The relay forwards only validated, allowlisted messages. Browser commands are
sent to a paired local agent. Agent updates are sent only to browsers watching
that paired agent.

Pairing uses typed messages too: the agent asks the relay for a code with
`pairing.begin`, the relay returns `pairing.code`, and the browser confirms it
with `pairing.confirm`. A paired browser can revoke its own authorization with
`pairing.revoke`; the relay acknowledges that with `pairing.revoked`.

Weather and ATIS requests are typed as `weather.request` and `atis.request`.
The local agent translates them into IVAO/FSD requests only after they reach the
PC that owns the IVAO connection.

Station lists are typed as `stations.state`. They contain only the public
station snapshot needed by the UI: callsign, frequency, optional coordinates,
and optional voice-channel text.

The protocol envelope is preserved during forwarding so every hop can trace the
same message id and message type. The relay remains responsible for rejecting
unknown message types and unsupported source/type combinations before routing.

## Example

```js
const {
  MESSAGE_SOURCES,
  MESSAGE_TYPES,
  createRemoteMessage,
  validateRemoteMessage,
} = require('./packages/protocol');

const message = createRemoteMessage(MESSAGE_TYPES.RADIO_SET, {
  com: 1,
  freq: '128.350',
});

const result = validateRemoteMessage(message, {
  source: MESSAGE_SOURCES.BROWSER,
});

if (!result.ok) throw new Error(result.error);
```
