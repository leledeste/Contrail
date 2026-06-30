# Privacy Notes

Status: design guidance. This is not legal advice.

Contrail should be designed so remote access can work without storing IVAO traffic, voice audio, or chat history on a central server.

## Data Minimization

The relay should collect only the data needed to authenticate users, pair devices, route live sessions, and protect the service from abuse.

## Data The Relay May Need

- Account identifier, such as email or OAuth subject.
- Hashed authentication/session identifiers.
- Paired device metadata, such as device name and creation time.
- Preview paired-browser records, stored as hashed browser ids and agent ids.
- Session metadata, such as connection time and device id.
- Security logs, such as failed login or authorization failures.
- Minimal relay audit events for admin actions, agent connect/disconnect, and
  pairing create/revoke events.
- IP addresses in short-lived security logs.

## Data The Relay Should Not Store

- IVAO credentials.
- Altitude credentials.
- Voice audio recordings.
- Raw TS2 packets.
- Raw FSD packets.
- Chat history.
- Full message contents.
- Full authentication tokens.
- Pairing codes after use or expiry.

## Retention Targets

Suggested defaults:

- Account records: until account deletion.
- Device records: until device revocation or account deletion.
- Active session records: deleted when no longer needed.
- Security logs: 30-90 days.
- Pairing codes: 60-120 seconds.
- Preview paired-browser records: until browser revocation or manual relay store deletion.
- Raw remote payloads: not persisted.

Self-hosted operators can choose different retention, but they should document it.

## User Controls

Remote mode should eventually provide:

- Delete account.
- Revoke device.
- Revoke all sessions.
- Export account/device metadata.
- Disable remote access from the local agent.

## Self-Hosted Responsibility

When someone self-hosts a relay, they become responsible for their own deployment, logs, backups, users, and privacy obligations.

The project should provide safe defaults, but operators still need to configure hosting, backups, access control, and retention responsibly.

## Official Relay Responsibility

If an official relay is offered, it should publish:

- Privacy policy.
- Terms of use.
- Data retention policy.
- List of infrastructure providers.
- Security contact.
- Breach/incident process.

## Design Defaults

- Remote access disabled by default in the local agent.
- No public exposure of the local proxy.
- Parsed local FSD events sent to the browser should omit raw protocol lines.
- No chat or audio storage on the relay.
- Remote RX and TX audio forwarding should remain live-only and should not be cached or replayed.
- Short-lived pairing.
- Revocable devices.
- Minimal logs. Relay audit events should store metadata such as event type,
  user id, agent id, pairing id, timestamp, and IP address, not chat text,
  voice audio, raw FSD, or raw TS2 data.
- Clear UI indication when a remote session is active.
