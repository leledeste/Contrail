// Load a simple relay .env file, then start the relay.
//
// This intentionally avoids a dotenv dependency. The parser supports the common
// KEY=value shape used by the example file and ignores comments/blank lines.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envFile = process.env.CONTRAIL_RELAY_ENV_FILE || path.join(root, 'apps', 'relay', '.env');

function applyEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

const loaded = applyEnvFile(envFile);
console.log(`[relay] Env file: ${loaded ? envFile : 'not found, using process environment'}`);

require('../apps/relay');
