'use strict';

// Relay account API smoke test.
//
// This starts a real relay with SQLite auth and public registration enabled,
// then verifies the intended hosted-account flow: registration creates an
// agent token, the agent connects with that token, and a logged-in browser can
// open a WebSocket with only its HttpOnly session cookie.

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const {
  MESSAGE_TYPES,
  createRemoteMessage,
} = require('../packages/protocol');

const root = path.resolve(__dirname, '..');
const allowedOrigin = 'https://app.example.test';
const agentDeviceId = 'device-account-test';
const browserId = 'browser-account-test';

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-relay-account-'));
  let relay = null;

  try {
    const port = await getFreePort();
    relay = await startRelay({ port, dataDir: tempDir, dbFile: path.join(tempDir, 'contrail.db') });

    const registered = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: {
        userId: 'account_user',
        displayName: 'Account User',
        password: 'correct horse battery staple',
      },
    });
    assert.strictEqual(registered.status, 201, 'registration should create an account');
    assert.ok(registered.body.agentToken, 'registration should return one-time agent token');
    assert.ok(registered.cookie, 'registration should set a browser session cookie');

    const duplicate = await fetchJson(port, '/account/api/register', {
      method: 'POST',
      body: {
        userId: 'account_user',
        displayName: 'Duplicate',
        password: 'another correct horse battery staple',
      },
    });
    assert.strictEqual(duplicate.status, 409, 'duplicate registration should be rejected');
    assert.strictEqual(duplicate.body.code, 'username_taken', 'duplicate registration should return a stable code');

    const badLogin = await fetchJson(port, '/account/api/login', {
      method: 'POST',
      body: {
        userId: 'account_user',
        password: 'wrong password value',
      },
    });
    assert.strictEqual(badLogin.status, 401, 'wrong login password should be rejected');
    assert.strictEqual(badLogin.body.code, 'invalid_credentials', 'wrong login should not reveal which field failed');

    const me = await fetchJson(port, '/account/api/me', { cookie: registered.cookie });
    assert.strictEqual(me.status, 200, 'session cookie should authenticate /me');
    assert.strictEqual(me.body.user.userId, 'account_user', 'session should identify the account');

    const baseWs = `ws://127.0.0.1:${port}/ws`;
    const agent = await connectClient(baseWs, 'agent', { token: registered.body.agentToken });
    const browser = await connectClient(baseWs, 'browser', { cookie: registered.cookie, browserId });

    try {
      agent.send(MESSAGE_TYPES.AGENT_HELLO, { deviceId: agentDeviceId, deviceName: 'Account Test PC' });
      await agent.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.DEVICE_LIST);
      await browser.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.DEVICE_SELECT, { deviceId: agentDeviceId });
      await browser.waitFor((message) => message.type === MESSAGE_TYPES.DEVICE_STATE && message.payload.deviceId === agentDeviceId);

      browser.send(MESSAGE_TYPES.RADIO_SET, { com: 1, freq: '128.350' });
      const routed = await agent.waitFor((message) => message.type === MESSAGE_TYPES.RADIO_SET);
      assert.strictEqual(routed.payload.freq, '128.350', 'session browser commands should reach the account agent');
    } finally {
      agent.close();
      browser.close();
    }

    const rotated = await fetchJson(port, '/account/api/agent-token/rotate', {
      method: 'POST',
      cookie: registered.cookie,
    });
    assert.strictEqual(rotated.status, 200, 'account token rotation should work');
    assert.ok(rotated.body.agentToken, 'rotation should return a new one-time token');
    assert.notStrictEqual(rotated.body.agentToken, registered.body.agentToken, 'rotation should replace the old token');

    await assertRejected(baseWs, registered.body.agentToken);
    await assertConnectsAs(baseWs, rotated.body.agentToken, 'account_user');

    console.log('[OK] relay account API');
  } finally {
    await stopRelay(relay);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function startRelay(options) {
  const relayProcess = spawn(process.execPath, [path.join(root, 'apps/relay/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      CONTRAIL_RELAY_HOST: '127.0.0.1',
      CONTRAIL_RELAY_PORT: String(options.port),
      CONTRAIL_RELAY_AUTH_MODE: 'sqlite-fallback',
      CONTRAIL_RELAY_DATABASE: options.dbFile,
      CONTRAIL_RELAY_USERS: '',
      CONTRAIL_RELAY_TOKEN: '',
      CONTRAIL_ALLOWED_ORIGINS: allowedOrigin,
      CONTRAIL_RELAY_ENABLE_REGISTRATION: 'true',
      CONTRAIL_RELAY_REQUIRE_PAIRING: 'true',
      CONTRAIL_RELAY_DATA_DIR: options.dataDir,
      CONTRAIL_RELAY_PAIRINGS_FILE: path.join(options.dataDir, 'pairings.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  relayProcess.stdout.on('data', (chunk) => { output += chunk.toString(); });
  relayProcess.stderr.on('data', (chunk) => { output += chunk.toString(); });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${options.port}/health`).catch(() => null);
    return response && response.ok;
  }, () => `relay startup\n${output.trim()}`);

  return relayProcess;
}

async function fetchJson(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      origin: allowedOrigin,
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
  return { status: response.status, body, cookie };
}

async function connectClient(baseWs, source, options) {
  const params = new URLSearchParams({ source });
  if (options.token) params.set('token', options.token);
  if (options.browserId) params.set('browserId', options.browserId);

  const ws = new WebSocket(`${baseWs}?${params.toString()}`, {
    origin: allowedOrigin,
    headers: options.cookie ? { cookie: options.cookie } : undefined,
  });
  const client = new RelayClient(source, ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  const identity = await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  assert.strictEqual(identity.payload.userId, 'account_user', `${source} should authenticate as account_user`);
  return client;
}

async function assertConnectsAs(baseWs, token, userId) {
  const ws = new WebSocket(`${baseWs}?source=agent&token=${encodeURIComponent(token)}`, { origin: allowedOrigin });
  const client = new RelayClient('agent-check', ws);
  await client.open();
  await client.waitFor((message) => message.type === MESSAGE_TYPES.PONG);
  const identity = await client.waitFor((message) => message.type === MESSAGE_TYPES.RELAY_IDENTITY);
  assert.strictEqual(identity.payload.userId, userId, `token should authenticate as ${userId}`);
  client.close();
}

async function assertRejected(baseWs, token) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWs}?source=agent&token=${encodeURIComponent(token)}`, { origin: allowedOrigin });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (_) {}
      reject(new Error('old token was not rejected'));
    }, 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('old token unexpectedly connected'));
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      assert.ok(res.statusCode >= 400, 'old token should receive HTTP error');
      resolve();
    });
    ws.once('error', () => {});
  });
}

class RelayClient {
  constructor(name, ws) {
    this.name = name;
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    this.closed = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString('utf8'));
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.queue.push(message);
    });

    ws.on('close', () => {
      this.closed = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name} socket closed while waiting for message`));
      }
    });
  }

  open() {
    return onceOpen(this.ws);
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify(createRemoteMessage(type, payload, `${this.name}-${Date.now().toString(36)}`)));
  }

  waitFor(predicate, timeoutMs = 2500) {
    const existingIndex = this.queue.findIndex(predicate);
    if (existingIndex >= 0) {
      const [message] = this.queue.splice(existingIndex, 1);
      return Promise.resolve(message);
    }
    if (this.closed) return Promise.reject(new Error(`${this.name} socket is closed`));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.name} timed out waiting for relay message`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 1500);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function stopRelay(relayProcess) {
  if (!relayProcess || relayProcess.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { relayProcess.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 1500);
    relayProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { relayProcess.kill(); } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(typeof label === 'function' ? label() : `Timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
