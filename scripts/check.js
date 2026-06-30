// Lightweight project health check.
//
// This script intentionally avoids external tooling. It verifies the files a
// GitHub checkout needs, checks Node syntax for the proxy, checks the inline
// browser scripts, and validates JSON files.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve from the repository root even when the script is launched from a
// different working directory.
const root = path.resolve(__dirname, '..');

// These files describe or run the current public package. Keeping screenshots
// in the required list prevents the README from referencing missing assets.
const requiredFiles = [
  'README.md',
  'docs/README.md',
  'docs/PROJECT_STATUS.md',
  'docs/DEVELOPER_TOOLS.md',
  'docs/USAGE_MODES.md',
  'docs/REMOTE_ARCHITECTURE.md',
  'docs/REMOTE_TESTING.md',
  'docs/SELF_HOSTING.md',
  'docs/DEPENDENCY_POLICY.md',
  'docs/DATABASE_DESIGN.md',
  'SECURITY.md',
  'docs/PRIVACY.md',
  'docs/THREAT_MODEL.md',
  'docs/THIRD_PARTY_NOTICES.md',
  'docs/RELEASE_NOTES.md',
  'docs/AUTH_ARCHITECTURE.md',
  'docs/TECHNICAL_PAPER.md',
  'LICENSE',
  '.dockerignore',
  '.github/workflows/ci.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'proxy.js',
  'proxy/app-state.js',
  'proxy/config.js',
  'proxy/fsd-proxy.js',
  'proxy/fsd-parser.js',
  'proxy/local-web-server.js',
  'proxy/ogg-speex.js',
  'proxy/pilot-bridge.js',
  'proxy/pilot-core.js',
  'proxy/port-diagnostics.js',
  'proxy/remote-agent.js',
  'proxy/socket-utils.js',
  'proxy/static-web.js',
  'proxy/ts2-voice-proxy.js',
  'proxy/web-tx.js',
  'proxy/websocket-commands.js',
  'apps/relay/index.js',
  'apps/relay/db.js',
  'apps/relay/admin.html',
  'apps/relay/migrations/001_initial_identity.sql',
  'apps/relay/migrations/002_account_passwords.sql',
  'apps/relay/README.md',
  'apps/relay/.env.example',
  'infra/docker/relay.Dockerfile',
  'infra/docker/docker-compose.yml',
  'infra/docker/Caddyfile',
  'infra/docker/.env.example',
  'packages/protocol/index.js',
  'packages/protocol/README.md',
  'scripts/run-relay.js',
  'scripts/relay-user.js',
  'scripts/import-relay-users.js',
  'scripts/relay-db-user.js',
  'scripts/test-relay-db.js',
  'scripts/test-relay-db-auth.js',
  'scripts/test-relay-db-user.js',
  'scripts/test-relay-admin.js',
  'scripts/test-relay-account.js',
  'scripts/check-remote-preview.js',
  'scripts/test-remote-preview.js',
  'webapp/index.html',
  'webapp/styles.css',
  'webapp/app.js',
  'config.example.json',
  'package.json',
  'package-lock.json',
  'assets/screenshot-webapp.png',
  'assets/screenshot-radio-dropdown.png',
];

let failures = 0;

function check(label, fn) {
  // Keep running after failures so one command reports the full checklist.
  try {
    fn();
    console.log(`[OK] ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`[FAIL] ${label}`);
    console.error(`       ${err.message}`);
  }
}

function filePath(relativePath) {
  // Use repository-relative paths everywhere to keep error messages readable.
  return path.join(root, relativePath);
}

function requireFile(relativePath) {
  // Existence is enough here; content-specific checks happen in the dedicated
  // JSON/syntax steps below.
  if (!fs.existsSync(filePath(relativePath))) {
    throw new Error(`${relativePath} is missing`);
  }
}

function parseJson(relativePath) {
  // JSON.parse catches broken package/config files before users hit runtime.
  JSON.parse(fs.readFileSync(filePath(relativePath), 'utf8'));
}

function checkNodeSyntax(relativePath) {
  // node --check parses the file without executing the proxy or opening ports.
  const result = spawnSync(process.execPath, ['--check', filePath(relativePath)], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'node --check failed').trim());
  }
}

function runNodeScript(relativePath) {
  // Some checks need to execute a tiny isolated script, for example database
  // migrations against a temporary file.
  const result = spawnSync(process.execPath, [filePath(relativePath)], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'node script failed').trim());
  }
}

function checkInlineHtmlScript(relativePath) {
  // Some small browser surfaces still keep JavaScript inline. Extracting the
  // script catches syntax errors without needing a browser or dev server.
  const html = fs.readFileSync(filePath(relativePath), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error(`${relativePath} does not contain an inline script`);
  new Function(match[1]);
}

function checkWebappReferences() {
  const html = fs.readFileSync(filePath('webapp/index.html'), 'utf8');
  if (!html.includes('href="styles.css"')) throw new Error('webapp/index.html does not reference styles.css');
  if (!html.includes('src="app.js"')) throw new Error('webapp/index.html does not reference app.js');
}

function checkRemoteProtocol() {
  // The remote protocol is security-sensitive: the relay must start from an
  // allowlist and reject unknown/raw command shapes by default.
  const protocol = require(filePath('packages/protocol'));
  const validRadio = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' }, 'check-radio'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!validRadio.ok) throw new Error(`valid radio message rejected: ${validRadio.error}`);

  const invalidRadioFrequency = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '199.999' }, 'check-radio-range'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (invalidRadioFrequency.ok) throw new Error('out-of-range radio frequency accepted');

  const wrongSource = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' }, 'check-source'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (wrongSource.ok) throw new Error('radio.set accepted from agent source');

  const unknown = protocol.validateRemoteMessage(
    { v: protocol.REMOTE_PROTOCOL_VERSION, id: 'check-raw', type: 'fsd.raw', payload: { line: '$CQ...' } },
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (unknown.ok) throw new Error('unknown raw message type accepted');

  const agentHello = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_HELLO, { deviceName: 'Home PC' }, 'check-agent'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!agentHello.ok) throw new Error(`valid agent hello rejected: ${agentHello.error}`);

  const deviceSelect = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.DEVICE_SELECT, { deviceId: 'dev-12345678' }, 'check-select'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!deviceSelect.ok) throw new Error(`valid device select rejected: ${deviceSelect.error}`);

  const pairingCode = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_CODE, { code: 'ABC-123', expiresAt: '2026-01-01T00:00:00.000Z' }, 'check-pair-code'),
    { source: protocol.MESSAGE_SOURCES.RELAY }
  );
  if (!pairingCode.ok) throw new Error(`valid pairing.code rejected: ${pairingCode.error}`);

  const pairingConfirm = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_CONFIRM, { code: 'ABC-123' }, 'check-pair-confirm'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!pairingConfirm.ok) throw new Error(`valid pairing.confirm rejected: ${pairingConfirm.error}`);

  const pairingRevoke = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_REVOKE, { deviceId: 'dev-12345678' }, 'check-pair-revoke'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!pairingRevoke.ok) throw new Error(`valid pairing.revoke rejected: ${pairingRevoke.error}`);

  const pairingRevoked = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.PAIRING_REVOKED, { deviceId: 'dev-12345678' }, 'check-pair-revoked'),
    { source: protocol.MESSAGE_SOURCES.RELAY }
  );
  if (!pairingRevoked.ok) throw new Error(`valid pairing.revoked rejected: ${pairingRevoked.error}`);

  const txStart = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.TX_START, { com: 1 }, 'check-tx-start'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!txStart.ok) throw new Error(`valid tx.start rejected: ${txStart.error}`);

  const weatherRequest = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.WEATHER_REQUEST, { kind: 'metar', icao: 'LIMC' }, 'check-weather'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!weatherRequest.ok) throw new Error(`valid weather.request rejected: ${weatherRequest.error}`);

  const atisRequest = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.ATIS_REQUEST, { callsign: 'LIMC_TWR' }, 'check-atis'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (!atisRequest.ok) throw new Error(`valid atis.request rejected: ${atisRequest.error}`);

  const agentStatus = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_STATUS, {
      connected: true,
      callsign: 'MHL212',
      squawk: '2000',
      xpdrMode: 'alt',
    }, 'check-status'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!agentStatus.ok) throw new Error(`valid agent.status rejected: ${agentStatus.error}`);

  const stationsState = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.STATIONS_STATE, {
      stations: [{ callsign: 'LIMC_TWR', freq: '118.100', lat: 45.63, lon: 8.72 }],
      ownPosition: { lat: 45.50, lon: 8.80 },
    }, 'check-stations'),
    { source: protocol.MESSAGE_SOURCES.AGENT }
  );
  if (!stationsState.ok) throw new Error(`valid stations.state rejected: ${stationsState.error}`);

  const forgedAgentStatus = protocol.validateRemoteMessage(
    protocol.createRemoteMessage(protocol.MESSAGE_TYPES.AGENT_STATUS, { connected: true }, 'check-forged-status'),
    { source: protocol.MESSAGE_SOURCES.BROWSER }
  );
  if (forgedAgentStatus.ok) throw new Error('agent.status accepted from browser source');
}

function checkProxyPrivacyGuards() {
  // FSD lines can contain chat text and protocol details. The proxy may parse
  // them internally, but the console and browser history should receive typed
  // summaries instead of raw lines.
  for (const relativePath of ['proxy.js', 'proxy/fsd-proxy.js']) {
    const source = fs.readFileSync(filePath(relativePath), 'utf8');
    if (/console\.log\([^)]*line\.trim\(\)/.test(source)) {
      throw new Error(`${relativePath} logs raw FSD lines to the console`);
    }
    if (/\bbroadcast\(msg\)/.test(source) || /\bstate\.broadcast\(msg\)/.test(source)) {
      throw new Error(`${relativePath} broadcasts raw parsed FSD events without stripping raw`);
    }
  }
}

function checkDependencyLicenses() {
  // This is intentionally conservative and dependency-light. It catches obvious
  // policy violations while THIRD_PARTY_NOTICES.md remains the human-readable
  // source of truth for reviewed direct dependencies.
  const lock = JSON.parse(fs.readFileSync(filePath('package-lock.json'), 'utf8'));
  const allowed = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense'];
  const blocked = ['GPL', 'AGPL', 'SSPL', 'Commons Clause', 'Business Source License'];

  for (const [name, meta] of Object.entries(lock.packages || {})) {
    if (!name || !name.startsWith('node_modules/')) continue;
    const license = String(meta.license || '').trim();
    if (!license) throw new Error(`${name} has no license in package-lock.json`);
    if (blocked.some((item) => license.includes(item))) {
      throw new Error(`${name} uses blocked license expression: ${license}`);
    }
    if (!allowed.some((item) => license.includes(item))) {
      throw new Error(`${name} uses unreviewed license expression: ${license}`);
    }
  }
}

// The checks below are ordered from structural to behavioral so early output is
// easy to scan when a fresh checkout is incomplete.
check('required files', () => requiredFiles.forEach(requireFile));
check('proxy.js syntax', () => checkNodeSyntax('proxy.js'));
check('proxy app state syntax', () => checkNodeSyntax('proxy/app-state.js'));
check('proxy config syntax', () => checkNodeSyntax('proxy/config.js'));
check('proxy FSD proxy syntax', () => checkNodeSyntax('proxy/fsd-proxy.js'));
check('proxy fsd parser syntax', () => checkNodeSyntax('proxy/fsd-parser.js'));
check('proxy local web server syntax', () => checkNodeSyntax('proxy/local-web-server.js'));
check('proxy ogg-speex syntax', () => checkNodeSyntax('proxy/ogg-speex.js'));
check('proxy pilot bridge syntax', () => checkNodeSyntax('proxy/pilot-bridge.js'));
check('proxy pilot core syntax', () => checkNodeSyntax('proxy/pilot-core.js'));
check('proxy port diagnostics syntax', () => checkNodeSyntax('proxy/port-diagnostics.js'));
check('proxy remote agent syntax', () => checkNodeSyntax('proxy/remote-agent.js'));
check('proxy socket utils syntax', () => checkNodeSyntax('proxy/socket-utils.js'));
check('proxy static web syntax', () => checkNodeSyntax('proxy/static-web.js'));
check('proxy TS2 voice proxy syntax', () => checkNodeSyntax('proxy/ts2-voice-proxy.js'));
check('proxy web tx syntax', () => checkNodeSyntax('proxy/web-tx.js'));
check('proxy websocket commands syntax', () => checkNodeSyntax('proxy/websocket-commands.js'));
check('relay syntax', () => checkNodeSyntax('apps/relay/index.js'));
check('relay db syntax', () => checkNodeSyntax('apps/relay/db.js'));
check('relay runner syntax', () => checkNodeSyntax('scripts/run-relay.js'));
check('relay user helper syntax', () => checkNodeSyntax('scripts/relay-user.js'));
check('relay user import syntax', () => checkNodeSyntax('scripts/import-relay-users.js'));
check('relay database user helper syntax', () => checkNodeSyntax('scripts/relay-db-user.js'));
check('relay db migration syntax', () => checkNodeSyntax('scripts/test-relay-db.js'));
check('relay db auth syntax', () => checkNodeSyntax('scripts/test-relay-db-auth.js'));
check('relay db user test syntax', () => checkNodeSyntax('scripts/test-relay-db-user.js'));
check('relay admin test syntax', () => checkNodeSyntax('scripts/test-relay-admin.js'));
check('relay account test syntax', () => checkNodeSyntax('scripts/test-relay-account.js'));
check('remote preflight syntax', () => checkNodeSyntax('scripts/check-remote-preview.js'));
check('remote simulation syntax', () => checkNodeSyntax('scripts/test-remote-preview.js'));
check('remote protocol syntax', () => checkNodeSyntax('packages/protocol/index.js'));
check('remote protocol rules', checkRemoteProtocol);
check('relay database migrations', () => runNodeScript('scripts/test-relay-db.js'));
check('relay database auth', () => runNodeScript('scripts/test-relay-db-auth.js'));
check('relay database user helper', () => runNodeScript('scripts/test-relay-db-user.js'));
check('relay admin api', () => runNodeScript('scripts/test-relay-admin.js'));
check('relay account api', () => runNodeScript('scripts/test-relay-account.js'));
check('proxy privacy guards', checkProxyPrivacyGuards);
check('dependency licenses', checkDependencyLicenses);
check('webapp asset references', checkWebappReferences);
check('webapp script syntax', () => checkNodeSyntax('webapp/app.js'));
check('relay admin script syntax', () => checkInlineHtmlScript('apps/relay/admin.html'));
check('package.json', () => parseJson('package.json'));
check('package-lock.json', () => parseJson('package-lock.json'));
check('config.example.json', () => parseJson('config.example.json'));

if (fs.existsSync(filePath('config.json'))) {
  check('config.json', () => parseJson('config.json'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}

console.log('\nAll checks passed.');
