'use strict';

/**
 * Minimal Contrail Relay skeleton.
 *
 * This is not the production remote relay yet. It provides the safe outer
 * shell: HTTP healthcheck, WebSocket upgrade, origin allowlist, scoped token
 * gate, shared protocol validation, in-memory devices, browser pairing, a
 * narrow message router, and live Remote RX/TX PCM forwarding. Full accounts
 * remain future work; scoped tokens are the first multi-user isolation layer.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');
const {
  MESSAGE_SOURCES,
  MESSAGE_TYPES,
  createRemoteMessage,
  parseRemoteJson,
} = require('../../packages/protocol');

const HOST = process.env.CONTRAIL_RELAY_HOST || '127.0.0.1';
const PORT = Number(process.env.CONTRAIL_RELAY_PORT || 8787);
// Local remote-preview testing serves the webapp from the proxy on :3000 while
// the relay listens on :8787, so both origins are allowed by default.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];
const ALLOWED_ORIGINS = parseList(process.env.CONTRAIL_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','));
const DEFAULT_USER_ID = 'default';
const AUTH_MODE_ENV = 'env';
const AUTH_MODE_SQLITE_FALLBACK = 'sqlite-fallback';
const AUTH_MODE_SQLITE = 'sqlite';
const RELAY_AUTH_MODE = parseRelayAuthMode(process.env);
const ADMIN_TOKEN = String(process.env.CONTRAIL_RELAY_ADMIN_TOKEN || '').trim();
const ADMIN_TOKEN_HASH = ADMIN_TOKEN ? hashSecret(ADMIN_TOKEN) : null;
const ENABLE_ACCOUNT_REGISTRATION = parseBool(process.env.CONTRAIL_RELAY_ENABLE_REGISTRATION, false);
const ACCOUNT_SESSION_COOKIE = String(process.env.CONTRAIL_RELAY_SESSION_COOKIE || 'contrail_session').trim() || 'contrail_session';
const ACCOUNT_SESSION_TTL_MS = clampInteger(process.env.CONTRAIL_RELAY_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000);
const ADMIN_HTML_FILE = path.join(__dirname, 'admin.html');
const relayUsers = loadRelayUsers();
if (!relayUsers.size) {
  const canBootstrapUsers = RELAY_AUTH_MODE !== AUTH_MODE_ENV && (ENABLE_ACCOUNT_REGISTRATION || ADMIN_TOKEN_HASH);
  if (canBootstrapUsers) {
    console.warn('[relay] No relay users configured yet. Start with /admin or account registration to create one.');
  } else {
    const configuredSource = RELAY_AUTH_MODE === AUTH_MODE_SQLITE
      ? 'active SQLite agent tokens'
      : 'CONTRAIL_RELAY_TOKEN, CONTRAIL_RELAY_USERS, or active SQLite agent tokens';
    console.error(`[relay] Configure ${configuredSource} before starting the relay.`);
    process.exit(1);
  }
}
const REQUIRE_PAIRING = parseBool(process.env.CONTRAIL_RELAY_REQUIRE_PAIRING, true);
const PAIRING_CODE_TTL_MS = clampInteger(process.env.CONTRAIL_PAIRING_TTL_MS, 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const PERSIST_PAIRINGS = parseBool(process.env.CONTRAIL_RELAY_PERSIST_PAIRINGS, true);
const RELAY_DATA_DIR = process.env.CONTRAIL_RELAY_DATA_DIR || path.join(process.cwd(), '.contrail-relay');
const PAIRING_STORE_FILE = process.env.CONTRAIL_RELAY_PAIRINGS_FILE || path.join(RELAY_DATA_DIR, 'pairings.json');
const MAX_CLIENTS = clampInteger(process.env.CONTRAIL_RELAY_MAX_CLIENTS, 100, 1, 1000);
const RATE_WINDOW_MS = clampInteger(process.env.CONTRAIL_RELAY_RATE_WINDOW_MS, 10 * 1000, 1000, 60 * 1000);
const MAX_MESSAGES_PER_WINDOW = clampInteger(process.env.CONTRAIL_RELAY_MAX_MESSAGES_PER_WINDOW, 240, 10, 5000);
const MAX_COMMANDS_PER_WINDOW = clampInteger(process.env.CONTRAIL_RELAY_MAX_COMMANDS_PER_WINDOW, 80, 5, 2000);
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = clampInteger(process.env.CONTRAIL_RELAY_MAX_PAIRING_ATTEMPTS_PER_WINDOW, 10, 1, 200);
const MAX_AUDIO_FRAME_BYTES = clampInteger(process.env.CONTRAIL_RELAY_MAX_AUDIO_FRAME_BYTES, 32 * 1024, 320, 64 * 1024);
const TX_PACKET_MAGIC = Buffer.from('CTX1', 'ascii');
const MAX_REMOTE_TX_DURATION_MS = clampInteger(process.env.CONTRAIL_RELAY_MAX_REMOTE_TX_DURATION_MS, 120 * 1000, 5 * 1000, 10 * 60 * 1000);
const RATE_LIMIT_ERRORS = Object.freeze({
  commands: {
    code: 'command-rate-limited',
    message: 'Too many remote commands. Slow down and try again.',
  },
  pairings: {
    code: 'pairing-rate-limited',
    message: 'Too many pairing attempts. Slow down and try again.',
  },
  messages: {
    code: 'message-rate-limited',
    message: 'Too many remote messages. Slow down and try again.',
  },
});

const clients = new Map();
const devices = new Map();
const pairingCodes = new Map();
const browserAuthorizations = new Map();
loadPersistedPairings();

// Only these browser commands may cross the relay boundary. Keeping the router
// as an allowlist prevents the remote mode from becoming a raw protocol tunnel.
const BROWSER_TO_AGENT_TYPES = new Set([
  MESSAGE_TYPES.RADIO_SET,
  MESSAGE_TYPES.CHAT_SEND,
  MESSAGE_TYPES.WEATHER_REQUEST,
  MESSAGE_TYPES.ATIS_REQUEST,
  MESSAGE_TYPES.XPDR_SET_SQUAWK,
  MESSAGE_TYPES.XPDR_SET_MODE,
  MESSAGE_TYPES.XPDR_IDENT,
  MESSAGE_TYPES.TX_START,
  MESSAGE_TYPES.TX_STOP,
  MESSAGE_TYPES.MONITOR_START,
  MESSAGE_TYPES.MONITOR_STOP,
]);

// Agent updates are sent only to browsers that selected the same device.
const AGENT_TO_BROWSER_TYPES = new Set([
  MESSAGE_TYPES.AGENT_STATUS,
  MESSAGE_TYPES.RADIO_STATE,
  MESSAGE_TYPES.STATIONS_STATE,
  MESSAGE_TYPES.CHAT_MESSAGE,
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    return sendOptions(req, res);
  }

  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
    return sendAdminHtml(res);
  }

  if (url.pathname.startsWith('/account/api/')) {
    handleAccountApi(req, res, url).catch((err) => {
      if (isAccountApiError(err)) {
        sendJson(req, res, err.status, { ok: false, code: err.code, error: err.message });
        return;
      }
      console.error(`[relay-account] ${err.stack || err.message}`);
      sendJson(req, res, 500, { ok: false, error: 'internal error' });
    });
    return;
  }

  if (url.pathname.startsWith('/admin/api/')) {
    handleAdminApi(req, res, url).catch((err) => {
      console.error(`[relay-admin] ${err.stack || err.message}`);
      sendJson(req, res, 500, { ok: false, error: 'internal error' });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(req, res, 200, {
      ok: true,
      service: 'contrail-relay',
      clients: clients.size,
      devices: devices.size,
      users: relayUsers.size,
      pairingRequired: REQUIRE_PAIRING,
      persistedPairings: countPersistedPairings(),
    });
  }

  sendJson(req, res, 404, { ok: false, error: 'not found' });
});

const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 64 * 1024,
});

server.on('upgrade', (req, socket, head) => {
  const decision = authorizeUpgrade(req);
  if (!decision.ok) {
    socket.write(`HTTP/1.1 ${decision.status} ${decision.reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, decision);
  });
});

wss.on('connection', (ws, req, decision) => {
  const client = {
    id: crypto.randomUUID(),
    source: decision.source,
    userId: decision.userId,
    userName: decision.userName,
    authKind: decision.authKind || 'token',
    browserId: decision.browserId,
    connectedAt: Date.now(),
    remoteAddress: req.socket.remoteAddress || '',
    rate: createRateState(),
  };
  clients.set(ws, client);

  send(ws, createRemoteMessage(MESSAGE_TYPES.PONG, {}, `welcome-${client.id}`));
  send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_IDENTITY, {
    userId: client.userId,
    userName: client.userName || client.userId,
  }, `identity-${client.id}`));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(ws, client, data);
      return;
    }
    if (!allowRate(ws, client, 'messages', MAX_MESSAGES_PER_WINDOW)) return;

    const result = parseRemoteJson(data.toString('utf8'), { source: client.source });
    if (!result.ok) {
      send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
        code: 'invalid-message',
        message: result.error,
      }));
      return;
    }
    if (shouldRateLimitBrowserCommand(result.message.type) && !allowRate(ws, client, 'commands', MAX_COMMANDS_PER_WINDOW)) return;
    if (result.message.type === MESSAGE_TYPES.PAIRING_CONFIRM && !allowRate(ws, client, 'pairings', MAX_PAIRING_ATTEMPTS_PER_WINDOW)) return;

    handleMessage(ws, client, result.message);
  });

  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

function handleBinaryMessage(ws, client, data) {
  // Remote audio is the only binary path in the preview relay. Agent binary is
  // live RX PCM for paired browsers. Browser binary is TX microphone PCM and is
  // accepted only during an explicit tx.start/tx.stop window.
  const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!frame.length || frame.length > MAX_AUDIO_FRAME_BYTES) return closeProtocol(ws, 'invalid audio frame size');

  if (client.source === MESSAGE_SOURCES.AGENT && client.deviceId) {
    routeAgentAudio(ws, client, frame);
    return;
  }

  if (client.source === MESSAGE_SOURCES.BROWSER) {
    handleBrowserTxAudio(ws, client, frame);
    return;
  }

  closeProtocol(ws, 'unsupported binary source');
}

function handleBrowserTxAudio(ws, client, frame) {
  // Browser TX frames must be tied to the selected paired agent and to a live
  // tx.start session. The CTX1 prefix mirrors the local proxy WebSocket path and
  // prevents arbitrary browser binary frames from becoming a raw tunnel.
  if (!client.activeTxDeviceId || client.activeTxDeviceId !== client.selectedDeviceId) return;
  if (Date.now() - (client.activeTxStartedAt || 0) > MAX_REMOTE_TX_DURATION_MS) {
    stopBrowserTx(client, 'remote tx timed out');
    return;
  }
  if (frame.length <= TX_PACKET_MAGIC.length || !frame.subarray(0, TX_PACKET_MAGIC.length).equals(TX_PACKET_MAGIC)) {
    closeProtocol(ws, 'invalid tx audio frame');
    return;
  }

  const device = devices.get(scopedDeviceKey(client.userId, client.activeTxDeviceId));
  if (!device || !device.online || device.ws.readyState !== WebSocket.OPEN || !canClientAccessDevice(client, device.deviceId)) {
    stopBrowserTx(client, 'remote tx device unavailable');
    return;
  }

  sendBinary(device.ws, frame.subarray(TX_PACKET_MAGIC.length));
}

function shouldRateLimitBrowserCommand(type) {
  // TX start/stop are part of the live audio path. They are still guarded by
  // device selection, pairing/session checks, frame-size checks, and TX timeout,
  // but they should not be blocked while a user is testing or tapping PTT.
  return BROWSER_TO_AGENT_TYPES.has(type)
    && type !== MESSAGE_TYPES.TX_START
    && type !== MESSAGE_TYPES.TX_STOP;
}

function authorizeUpgrade(req) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== '/ws') return deny(404, 'not found');
  if (clients.size >= MAX_CLIENTS) return deny(503, 'too many clients');

  const origin = req.headers.origin || '';
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return deny(403, 'forbidden origin');

  const source = url.searchParams.get('source') || '';
  if (source !== MESSAGE_SOURCES.BROWSER && source !== MESSAGE_SOURCES.AGENT) return deny(400, 'invalid source');

  const browserId = url.searchParams.get('browserId') || '';
  if (source === MESSAGE_SOURCES.BROWSER && browserId && !isTokenLike(browserId)) {
    return deny(400, 'invalid browser id');
  }

  const token = url.searchParams.get('token') || '';
  const relayUser = findRelayUserByToken(token);
  if (relayUser) {
    return { ok: true, source, browserId, userId: relayUser.userId, userName: relayUser.userName, authKind: 'token' };
  }

  if (source === MESSAGE_SOURCES.BROWSER) {
    const sessionUser = findRelayUserBySession(req);
    if (sessionUser) {
      return {
        ok: true,
        source,
        browserId,
        userId: sessionUser.userId,
        userName: sessionUser.userName,
        authKind: 'session',
      };
    }
  }

  return deny(401, 'unauthorized');
}

function handleMessage(ws, client, message) {
  // This iteration keeps routing deliberately tiny: agents announce themselves,
  // browsers select one device, then only allowlisted operational messages flow.
  if (message.type === MESSAGE_TYPES.PING) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.PONG, {}, `pong-${message.id}`));
    return;
  }

  if (message.type === MESSAGE_TYPES.AGENT_HELLO) {
    registerAgent(ws, client, message);
    return;
  }

  if (message.type === MESSAGE_TYPES.PAIRING_BEGIN) {
    refreshPairingCode(ws, client, message.payload.deviceName);
    return;
  }

  if (message.type === MESSAGE_TYPES.PAIRING_CONFIRM) {
    confirmPairing(ws, client, message.payload.code);
    return;
  }

  if (message.type === MESSAGE_TYPES.PAIRING_REVOKE) {
    revokePairing(ws, client, message.payload.deviceId);
    return;
  }

  if (message.type === MESSAGE_TYPES.DEVICE_LIST) {
    sendDeviceList(ws, client);
    return;
  }

  if (message.type === MESSAGE_TYPES.DEVICE_SELECT) {
    selectDevice(ws, client, message.payload.deviceId);
    return;
  }

  if (BROWSER_TO_AGENT_TYPES.has(message.type)) {
    routeBrowserCommand(ws, client, message);
    return;
  }

  if (AGENT_TO_BROWSER_TYPES.has(message.type)) {
    routeAgentUpdate(ws, client, message);
    return;
  }

  send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
    code: 'not-routed',
    message: `validated ${message.type} from ${client.source}, routing is not implemented yet`,
  }));
}

async function handleAccountApi(req, res, url) {
  if (RELAY_AUTH_MODE === AUTH_MODE_ENV) {
    return sendJson(req, res, 409, {
      ok: false,
      code: 'account_mode_unavailable',
      error: 'account login requires sqlite-fallback or sqlite auth mode',
    });
  }

  if (req.method === 'GET' && url.pathname === '/account/api/status') {
    const session = getAccountSession(req);
    return sendJson(req, res, 200, {
      ok: true,
      registrationEnabled: ENABLE_ACCOUNT_REGISTRATION,
      authenticated: Boolean(session),
      user: session ? publicAccountUser(session) : null,
    });
  }

  if (req.method === 'GET' && url.pathname === '/account/api/me') {
    const session = getAccountSession(req);
    if (!session) return sendJson(req, res, 401, { ok: false, code: 'not_authenticated', error: 'not authenticated' });
    return sendJson(req, res, 200, { ok: true, user: publicAccountUser(session) });
  }

  if (req.method === 'POST' && url.pathname === '/account/api/register') {
    if (!ENABLE_ACCOUNT_REGISTRATION) {
      return sendJson(req, res, 403, { ok: false, code: 'registration_disabled', error: 'registration is disabled' });
    }

    const body = await readJsonBody(req);
    const userId = requireAccountUserId(body.userId);
    const displayName = requireAccountDisplayName(body.displayName || userId);
    const password = requireAccountPassword(body.password);
    const agentToken = generateRelayToken();
    const passwordHash = hashPassword(password);

    return withAccountDatabase((db) => {
      if (require('./db').getRelayUser(db, userId)) {
        return sendJson(req, res, 409, {
          ok: false,
          code: 'username_taken',
          error: 'username already exists',
        });
      }

      const account = require('./db').createRelayAccount(db, {
        userId,
        displayName,
        passwordHash,
        token: agentToken,
        tokenName: 'Relay preview token',
      });
      const session = createAccountSession(db, req, userId);
      insertAccountAuditEvent(db, req, {
        eventType: 'account.registered',
        userId,
        metadata: { tokenPrefix: account.tokenPrefix },
      });
      reloadRelayUsers();
      return sendJson(req, res, 201, {
        ok: true,
        user: publicAccountUser(session),
        agentToken,
        tokenPrefix: account.tokenPrefix,
      }, sessionCookieHeaders(req, session.sessionToken, session.expiresAt));
    });
  }

  if (req.method === 'POST' && url.pathname === '/account/api/login') {
    const body = await readJsonBody(req);
    const userId = String(body.userId || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isUserId(userId) || password.length < 1 || password.length > 256) {
      return sendJson(req, res, 401, {
        ok: false,
        code: 'invalid_credentials',
        error: 'invalid username or password',
      });
    }

    return withAccountDatabase((db) => {
      const user = require('./db').getRelayUserCredentials(db, userId);
      if (!user || user.disabledAt || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        return sendJson(req, res, 401, { ok: false, code: 'invalid_credentials', error: 'invalid username or password' });
      }

      const session = createAccountSession(db, req, user.userId);
      insertAccountAuditEvent(db, req, {
        eventType: 'account.login',
        userId: user.userId,
      });
      return sendJson(req, res, 200, {
        ok: true,
        user: publicAccountUser(session),
      }, sessionCookieHeaders(req, session.sessionToken, session.expiresAt));
    });
  }

  if (req.method === 'POST' && url.pathname === '/account/api/logout') {
    const token = getSessionTokenFromRequest(req);
    if (token) {
      withAccountDatabase((db) => {
        require('./db').revokeBrowserSession(db, token);
      });
    }
    return sendJson(req, res, 200, { ok: true }, clearSessionCookieHeaders(req));
  }

  if (req.method === 'POST' && url.pathname === '/account/api/agent-token/rotate') {
    const session = getAccountSession(req);
    if (!session) return sendJson(req, res, 401, { ok: false, code: 'not_authenticated', error: 'not authenticated' });

    return withAccountDatabase((db) => {
      const agentToken = generateRelayToken();
      const result = require('./db').importRelayUserToken(db, {
        userId: session.userId,
        displayName: session.userName || session.userId,
        token: agentToken,
        tokenName: 'Relay preview token',
      });
      insertAccountAuditEvent(db, req, {
        eventType: 'account.agent_token_rotated',
        userId: session.userId,
        metadata: { tokenPrefix: result.tokenPrefix },
      });
      reloadRelayUsers();
      closeAgentClientsForUser(session.userId, 'relay token rotated');
      return sendJson(req, res, 200, {
        ok: true,
        agentToken,
        tokenPrefix: result.tokenPrefix,
      });
    });
  }

  return sendJson(req, res, 404, { ok: false, error: 'not found' });
}

async function handleAdminApi(req, res, url) {
  const admin = authorizeAdminRequest(req);
  if (!admin.ok) {
    return sendJson(req, res, admin.status, { ok: false, error: admin.error });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/status') {
    return sendJson(req, res, 200, {
      ok: true,
      authMode: RELAY_AUTH_MODE,
      sqliteAdmin: RELAY_AUTH_MODE !== AUTH_MODE_ENV,
      users: relayUsers.size,
      database: defaultRelayDatabasePath(),
    });
  }

  if (RELAY_AUTH_MODE === AUTH_MODE_ENV) {
    return sendJson(req, res, 409, {
      ok: false,
      error: 'sqlite admin is disabled while CONTRAIL_RELAY_AUTH_MODE=env',
    });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/users') {
    return withAdminDatabase((db) => sendJson(req, res, 200, {
      ok: true,
      users: listAdminRelayUsers(db),
    }));
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/devices') {
    return withAdminDatabase((db) => sendJson(req, res, 200, {
      ok: true,
      devices: listAdminRelayDevices(db),
    }));
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/pairings') {
    return withAdminDatabase((db) => sendJson(req, res, 200, {
      ok: true,
      pairings: listAdminRelayPairings(db),
    }));
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/audit') {
    return withAdminDatabase((db) => sendJson(req, res, 200, {
      ok: true,
      events: listAdminAuditEvents(db),
    }));
  }

  const pairingAction = url.pathname.match(/^\/admin\/api\/pairings\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && pairingAction) {
    const pairingId = decodeURIComponent(pairingAction[1]);
    return withAdminDatabase((db) => {
      const result = revokeAdminRelayPairing(db, pairingId);
      if (!result) return sendJson(req, res, 404, { ok: false, error: 'pairing not found' });
      insertAdminAuditEvent(db, req, {
        eventType: 'pairing.revoked_admin',
        userId: result.userId,
        targetAgentId: result.deviceId,
        targetBrowserPairingId: result.pairingId,
        metadata: { deviceId: result.deviceId },
      });
      revokeBrowserAuthorizationByHash(result.userId, result.browserIdHash, result.deviceId);
      disconnectRevokedPairingClients(result.userId, result.browserIdHash, result.deviceId);
      return sendJson(req, res, 200, { ok: true, action: 'revoked', count: result.count });
    });
  }

  if (req.method === 'POST' && url.pathname === '/admin/api/users') {
    const body = await readJsonBody(req);
    const userId = requireAdminUserId(body.userId);
    return withAdminDatabase((db) => {
      const existing = getAdminRelayUser(db, userId);
      if (existing) return sendJson(req, res, 409, { ok: false, error: 'user already exists' });

      const token = generateRelayToken();
      const result = importAdminRelayUserToken(db, {
        userId,
        displayName: String(body.displayName || userId).trim() || userId,
        token,
      });
      insertAdminAuditEvent(db, req, {
        eventType: 'admin.user_created',
        userId,
        metadata: { targetUserId: userId },
      });
      reloadRelayUsers();
      sendJson(req, res, 201, { ok: true, action: result.action, userId, token });
    });
  }

  const userAction = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/(rotate|revoke|disable|enable|delete)$/);
  if (req.method === 'POST' && userAction) {
    const userId = requireAdminUserId(decodeURIComponent(userAction[1]));
    const action = userAction[2];
    return withAdminDatabase((db) => {
      const existing = getAdminRelayUser(db, userId);
      if (!existing) return sendJson(req, res, 404, { ok: false, error: 'user not found' });

      if (action === 'rotate') {
        const token = generateRelayToken();
        const result = importAdminRelayUserToken(db, {
          userId,
          displayName: existing.displayName || userId,
          token,
        });
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.token_rotated',
          userId,
          metadata: { targetUserId: userId },
        });
        reloadRelayUsers();
        closeClientsForUser(userId, 'relay token rotated');
        return sendJson(req, res, 200, { ok: true, action: result.action, userId, token });
      }

      if (action === 'revoke') {
        const result = revokeAdminRelayUserTokens(db, { userId });
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.tokens_revoked',
          userId,
          metadata: { targetUserId: userId, count: result.count },
        });
        reloadRelayUsers();
        closeClientsForUser(userId, 'relay token revoked');
        return sendJson(req, res, 200, { ok: true, action: result.action, userId, count: result.count });
      }

      if (action === 'disable' || action === 'enable') {
        const disabled = action === 'disable';
        const result = setAdminRelayUserDisabled(db, userId, disabled);
        insertAdminAuditEvent(db, req, {
          eventType: disabled ? 'admin.user_disabled' : 'admin.user_enabled',
          userId,
          metadata: { targetUserId: userId },
        });
        reloadRelayUsers();
        if (disabled) closeClientsForUser(userId, 'relay user disabled');
        return sendJson(req, res, 200, { ok: true, action: result.action, userId });
      }

      if (action === 'delete') {
        const pairings = require('./db').listActiveBrowserPairings(db)
          .filter((pairing) => pairing.userId === userId);
        insertAdminAuditEvent(db, req, {
          eventType: 'admin.user_deleted',
          userId,
          metadata: { targetUserId: userId, activePairingCount: pairings.length },
        });
        const result = deleteAdminRelayUser(db, userId);
        reloadRelayUsers();
        for (const pairing of pairings) {
          revokeBrowserAuthorizationByHash(pairing.userId, pairing.browserIdHash, pairing.deviceId);
        }
        closeClientsForUser(userId, 'relay user deleted');
        return sendJson(req, res, 200, { ok: true, action: result.action, userId, count: result.count });
      }

      return sendJson(req, res, 400, { ok: false, error: 'unknown action' });
    });
  }

  return sendJson(req, res, 404, { ok: false, error: 'not found' });
}

function registerAgent(ws, client, message) {
  const deviceId = message.payload.deviceId || `dev-${crypto.randomUUID()}`;
  const key = scopedDeviceKey(client.userId, deviceId);
  const existing = devices.get(key);
  const device = {
    key,
    userId: client.userId,
    deviceId,
    deviceName: message.payload.deviceName,
    online: true,
    ws,
    clientId: client.id,
    connectedAt: client.connectedAt,
    lastSeenAt: Date.now(),
    lastMessages: existing?.lastMessages || new Map(),
  };

  if (client.deviceKey && client.deviceKey !== key) devices.delete(client.deviceKey);
  client.deviceKey = key;
  client.deviceId = deviceId;
  client.deviceName = device.deviceName;
  devices.set(key, device);
  rememberRelayAgent(device);
  recordAuditEvent({
    eventType: 'agent.connected',
    userId: client.userId,
    actorType: 'agent',
    actorId: deviceId,
    ipAddress: client.remoteAddress,
    targetAgentId: deviceId,
    metadata: { deviceName: device.deviceName || deviceId },
  });

  send(ws, createRemoteMessage(MESSAGE_TYPES.DEVICE_STATE, {
    deviceId,
    deviceName: device.deviceName,
    online: true,
  }, `device-${message.id}`));
  broadcastDeviceState(device);
}

function refreshPairingCode(ws, client, deviceName) {
  // Pairing codes are short-lived and live only in this relay process. They
  // authorize one browser id to one agent without exposing local proxy ports.
  if (!REQUIRE_PAIRING) return;
  if (client.source !== MESSAGE_SOURCES.AGENT || !client.deviceId) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'pairing-unavailable',
      message: 'Agent must announce itself before requesting a pairing code',
    }));
    return;
  }

  deletePairingCodesForDevice(client.userId, client.deviceId);
  const code = generatePairingCode();
  const expiresAtMs = Date.now() + PAIRING_CODE_TTL_MS;
  pairingCodes.set(code, {
    userId: client.userId,
    deviceId: client.deviceId,
    expiresAtMs,
  });

  send(ws, createRemoteMessage(MESSAGE_TYPES.PAIRING_CODE, {
    code,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }, `pairing-${client.deviceId}`));
  console.log(`[relay] Pairing code issued for ${deviceName || client.deviceName || client.deviceId}`);
}

function confirmPairing(ws, client, code) {
  if (client.source !== MESSAGE_SOURCES.BROWSER) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'invalid-source',
      message: 'Only browser clients can confirm pairing',
    }));
    return;
  }
  if (!client.browserId) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'browser-id-required',
      message: 'This browser does not have a remote browser id',
    }));
    return;
  }

  purgeExpiredPairingCodes();
  const normalizedCode = normalizePairingCode(code);
  const pairing = pairingCodes.get(normalizedCode);
  const device = pairing && pairing.userId === client.userId
    ? devices.get(scopedDeviceKey(client.userId, pairing.deviceId))
    : null;
  if (!pairing || pairing.userId !== client.userId || !device || !device.online) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'pairing-invalid',
      message: 'Pairing code is invalid or expired',
    }));
    return;
  }

  authorizeBrowser(client.userId, client.browserId, pairing.deviceId);
  recordAuditEvent({
    eventType: 'pairing.created',
    userId: client.userId,
    actorType: 'browser',
    actorId: browserAuthorizationKey(client.userId, client.browserId).slice(0, 12),
    ipAddress: client.remoteAddress,
    targetAgentId: pairing.deviceId,
    metadata: { deviceId: pairing.deviceId },
  });
  pairingCodes.delete(normalizedCode);
  client.selectedDeviceId = pairing.deviceId;
  send(ws, createRemoteMessage(MESSAGE_TYPES.DEVICE_STATE, publicDevice(device), `paired-${pairing.deviceId}`));
  sendCachedDeviceState(ws, device);
}

function revokePairing(ws, client, deviceId) {
  if (client.source !== MESSAGE_SOURCES.BROWSER) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'invalid-source',
      message: 'Only browser clients can revoke browser pairing',
    }));
    return;
  }
  if (!client.browserId || !canClientAccessDevice(client, deviceId)) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'pairing-not-found',
      message: 'This browser is not paired with that agent',
    }));
    return;
  }

  if (client.activeTxDeviceId === deviceId) stopBrowserTx(client, 'remote tx stopped by pairing revoke');
  revokeBrowserAuthorization(client.userId, client.browserId, deviceId);
  recordAuditEvent({
    eventType: 'pairing.revoked_browser',
    userId: client.userId,
    actorType: 'browser',
    actorId: browserAuthorizationKey(client.userId, client.browserId).slice(0, 12),
    ipAddress: client.remoteAddress,
    targetAgentId: deviceId,
    metadata: { deviceId },
  });
  if (client.selectedDeviceId === deviceId) client.selectedDeviceId = '';
  send(ws, createRemoteMessage(MESSAGE_TYPES.PAIRING_REVOKED, { deviceId }, `revoked-${deviceId}`));
}

function sendDeviceList(ws, client) {
  for (const device of devices.values()) {
    if (device.userId !== client.userId) continue;
    if (!canClientAccessDevice(client, device.deviceId)) continue;
    send(ws, createRemoteMessage(MESSAGE_TYPES.DEVICE_STATE, publicDevice(device), `device-list-${device.deviceId}`));
  }
}

function selectDevice(ws, client, deviceId) {
  if (client.source !== MESSAGE_SOURCES.BROWSER) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'invalid-source',
      message: 'Only browser clients can select devices',
    }));
    return;
  }

  const device = devices.get(scopedDeviceKey(client.userId, deviceId));
  if (!device) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'device-not-found',
      message: 'Device is not online',
    }));
    return;
  }
  if (!canClientAccessDevice(client, deviceId)) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'pairing-required',
      message: 'Enter the pairing code shown by Contrail on the Altitude PC',
    }));
    return;
  }

  if (client.activeTxDeviceId && client.activeTxDeviceId !== deviceId) {
    stopBrowserTx(client, 'remote tx stopped by device switch');
  }
  client.selectedDeviceId = deviceId;
  send(ws, createRemoteMessage(MESSAGE_TYPES.DEVICE_STATE, publicDevice(device), `selected-${deviceId}`));
  sendCachedDeviceState(ws, device);
}

function routeBrowserCommand(ws, client, message) {
  // A browser must explicitly select a paired device before commands can leave
  // the relay. This keeps remote access away from raw, unowned tunnels.
  if (client.source !== MESSAGE_SOURCES.BROWSER) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'invalid-source',
      message: `${message.type} is only routable from browser clients`,
    }, `route-error-${message.id}`));
    return;
  }

  const device = client.selectedDeviceId ? devices.get(scopedDeviceKey(client.userId, client.selectedDeviceId)) : null;
  if (device && !canClientAccessDevice(client, device.deviceId)) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'pairing-required',
      message: 'Pair this browser before sending commands',
    }, `route-error-${message.id}`));
    return;
  }
  if (!device || !device.online || device.ws.readyState !== WebSocket.OPEN) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'device-not-selected',
      message: 'Select an online device before sending commands',
    }, `route-error-${message.id}`));
    return;
  }

  if (message.type === MESSAGE_TYPES.TX_START) {
    startBrowserTx(client, device.deviceId, message.payload.com);
  } else if (message.type === MESSAGE_TYPES.TX_STOP) {
    clearBrowserTx(client);
  }

  send(device.ws, message);
}

function startBrowserTx(client, deviceId, com) {
  client.activeTxDeviceId = deviceId;
  client.activeTxCom = com;
  client.activeTxStartedAt = Date.now();
}

function stopBrowserTx(client, reason = '') {
  const deviceId = client.activeTxDeviceId;
  clearBrowserTx(client);
  if (!deviceId) return;

  const device = devices.get(scopedDeviceKey(client.userId, deviceId));
  if (device?.online && device.ws.readyState === WebSocket.OPEN) {
    send(device.ws, createRemoteMessage(MESSAGE_TYPES.TX_STOP, {}, `tx-stop-${Date.now().toString(36)}`));
  }
  if (reason) {
    // This intentionally avoids logging audio or browser identifiers.
    console.warn(`[relay] ${reason}`);
  }
}

function clearBrowserTx(client) {
  client.activeTxDeviceId = '';
  client.activeTxCom = 0;
  client.activeTxStartedAt = 0;
}

function routeAgentUpdate(ws, client, message) {
  // Agent updates only make sense after agent.hello associated this socket with
  // a device. Broadcast only to browsers watching that device.
  if (client.source !== MESSAGE_SOURCES.AGENT || !client.deviceId) {
    send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, {
      code: 'invalid-source',
      message: `${message.type} requires an announced agent device`,
    }, `route-error-${message.id}`));
    return;
  }

  const device = devices.get(client.deviceKey);
  if (device) {
    device.lastSeenAt = Date.now();
    rememberDeviceSnapshot(device, message);
  }

  for (const [targetWs, targetClient] of clients.entries()) {
    if (targetClient.userId === client.userId && targetClient.source === MESSAGE_SOURCES.BROWSER && targetClient.selectedDeviceId === client.deviceId) {
      send(targetWs, message);
    }
  }
}

function routeAgentAudio(ws, client, frame) {
  // Remote RX audio is live-only. It is never cached because replaying stale
  // audio after a reconnect would be confusing and would violate the no-storage
  // rule for voice traffic.
  const device = devices.get(client.deviceKey);
  if (!device || device.ws !== ws) return;
  device.lastSeenAt = Date.now();

  for (const [targetWs, targetClient] of clients.entries()) {
    if (targetClient.userId === client.userId && targetClient.source === MESSAGE_SOURCES.BROWSER && targetClient.selectedDeviceId === client.deviceId) {
      sendBinary(targetWs, frame);
    }
  }
}

function rememberDeviceSnapshot(device, message) {
  // Status and radio state are snapshots, so replaying the latest value on
  // device selection keeps remote browsers in sync without duplicating chat.
  if (
    message.type === MESSAGE_TYPES.AGENT_STATUS
    || message.type === MESSAGE_TYPES.RADIO_STATE
    || message.type === MESSAGE_TYPES.STATIONS_STATE
  ) {
    device.lastMessages.set(message.type, message);
  }
}

function sendCachedDeviceState(ws, device) {
  for (const type of [MESSAGE_TYPES.AGENT_STATUS, MESSAGE_TYPES.RADIO_STATE, MESSAGE_TYPES.STATIONS_STATE]) {
    const message = device.lastMessages?.get(type);
    if (message) send(ws, message);
  }
}

function broadcastDeviceState(device) {
  for (const [ws, client] of clients.entries()) {
    if (client.userId !== device.userId) continue;
    if (client.source === MESSAGE_SOURCES.BROWSER && canClientAccessDevice(client, device.deviceId)) {
      send(ws, createRemoteMessage(MESSAGE_TYPES.DEVICE_STATE, publicDevice(device), `device-${device.deviceId}`));
    }
  }
}

function removeClient(ws) {
  const client = clients.get(ws);
  clients.delete(ws);
  if (client?.source === MESSAGE_SOURCES.BROWSER && client.activeTxDeviceId) {
    stopBrowserTx(client, 'remote tx stopped by browser disconnect');
  }
  if (!client || client.source !== MESSAGE_SOURCES.AGENT || !client.deviceId) return;

  const existing = devices.get(client.deviceKey);
  if (!existing || existing.ws !== ws) return;

  devices.delete(client.deviceKey);
  deletePairingCodesForDevice(client.userId, client.deviceId);
  recordAuditEvent({
    eventType: 'agent.disconnected',
    userId: client.userId,
    actorType: 'agent',
    actorId: client.deviceId,
    ipAddress: client.remoteAddress,
    targetAgentId: client.deviceId,
    metadata: { deviceName: client.deviceName || client.deviceId },
  });
  broadcastDeviceState({
    userId: client.userId,
    deviceId: client.deviceId,
    deviceName: client.deviceName || 'Unknown device',
    online: false,
  });
}

function canClientAccessDevice(client, deviceId) {
  const device = devices.get(scopedDeviceKey(client.userId, deviceId));
  if (device && device.userId !== client.userId) return false;
  if (!REQUIRE_PAIRING) return true;
  if (client.source === MESSAGE_SOURCES.AGENT && client.deviceId === deviceId) return true;
  if (client.source === MESSAGE_SOURCES.BROWSER && client.authKind === 'session') return true;
  if (client.source !== MESSAGE_SOURCES.BROWSER || !client.browserId) return false;
  if (browserAuthorizations.get(browserAuthorizationKey(client.userId, client.browserId))?.has(deviceId) === true) return true;
  return client.userId === DEFAULT_USER_ID
    && browserAuthorizations.get(legacyBrowserAuthorizationKey(client.browserId))?.has(deviceId) === true;
}

function authorizeBrowser(userId, browserId, deviceId) {
  const key = browserAuthorizationKey(userId, browserId);
  const existing = browserAuthorizations.get(key) || new Set();
  existing.add(deviceId);
  browserAuthorizations.set(key, existing);
  persistBrowserAuthorization(userId, browserId, deviceId);
}

function revokeBrowserAuthorization(userId, browserId, deviceId) {
  const key = browserAuthorizationKey(userId, browserId);
  const existing = browserAuthorizations.get(key);
  if (!existing) return false;
  existing.delete(deviceId);
  if (existing.size) browserAuthorizations.set(key, existing);
  else browserAuthorizations.delete(key);
  persistBrowserRevocation(userId, browserId, deviceId);
  return true;
}

function revokeBrowserAuthorizationByHash(userId, browserHash, deviceId) {
  const existing = browserAuthorizations.get(browserHash);
  if (!existing) return false;
  existing.delete(deviceId);
  if (existing.size) browserAuthorizations.set(browserHash, existing);
  else browserAuthorizations.delete(browserHash);
  return true;
}

function browserAuthorizationKey(userId, browserId) {
  // Browser ids are stable local identifiers, not secrets. Hash the scoped
  // user/browser pair so one browser id cannot authorize across users.
  return crypto.createHash('sha256').update(`${userId}:${browserId}`).digest('hex');
}

function legacyBrowserAuthorizationKey(browserId) {
  // Pairings created before multi-user token scopes used only the browser id.
  // Keep them valid for the default legacy user to avoid surprise re-pairing.
  return crypto.createHash('sha256').update(String(browserId)).digest('hex');
}

function countPersistedPairings() {
  let count = 0;
  for (const deviceIds of browserAuthorizations.values()) count += deviceIds.size;
  return count;
}

function loadPersistedPairings() {
  if (!PERSIST_PAIRINGS) return;
  if (pairingsUseDatabase()) {
    loadDatabasePairings();
    return;
  }
  loadFilePairings();
}

function loadFilePairings() {
  try {
    if (!fs.existsSync(PAIRING_STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PAIRING_STORE_FILE, 'utf8'));
    if (![1, 2].includes(data.version) || !Array.isArray(data.authorizations)) return;

    for (const item of data.authorizations) {
      if (!item || !/^[a-f0-9]{64}$/.test(item.browserHash) || !Array.isArray(item.deviceIds)) continue;
      const validDeviceIds = item.deviceIds.filter((deviceId) => isTokenLike(deviceId));
      if (validDeviceIds.length) browserAuthorizations.set(item.browserHash, new Set(validDeviceIds));
    }
    console.log(`[relay] Loaded persisted browser pairings: ${countPersistedPairings()}`);
  } catch (err) {
    console.warn(`[relay] Could not load persisted pairings: ${err.message}`);
  }
}

function persistPairings() {
  if (!PERSIST_PAIRINGS) return;
  if (pairingsUseDatabase()) return;
  try {
    fs.mkdirSync(path.dirname(PAIRING_STORE_FILE), { recursive: true });
    const authorizations = Array.from(browserAuthorizations.entries()).map(([browserHash, deviceIds]) => ({
      browserHash,
      deviceIds: Array.from(deviceIds).sort(),
      updatedAt: new Date().toISOString(),
    }));
    const body = JSON.stringify({ version: 2, authorizations }, null, 2);
    const tmpFile = `${PAIRING_STORE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, body);
    fs.renameSync(tmpFile, PAIRING_STORE_FILE);
  } catch (err) {
    console.warn(`[relay] Could not persist pairings: ${err.message}`);
  }
}

function pairingsUseDatabase() {
  return PERSIST_PAIRINGS && RELAY_AUTH_MODE !== AUTH_MODE_ENV;
}

function loadDatabasePairings() {
  try {
    const db = openAdminDatabase();
    try {
      for (const item of require('./db').listActiveBrowserPairings(db)) {
        if (!/^[a-f0-9]{64}$/.test(item.browserIdHash) || !isTokenLike(item.deviceId)) continue;
        const existing = browserAuthorizations.get(item.browserIdHash) || new Set();
        existing.add(item.deviceId);
        browserAuthorizations.set(item.browserIdHash, existing);
      }
    } finally {
      db.close();
    }
    console.log(`[relay] Loaded SQLite browser pairings: ${countPersistedPairings()}`);
  } catch (err) {
    console.warn(`[relay] Could not load SQLite pairings: ${err.message}`);
  }
}

function rememberRelayAgent(device) {
  if (!pairingsUseDatabase()) return;
  try {
    const db = openAdminDatabase();
    try {
      require('./db').upsertRelayAgent(db, {
        userId: device.userId,
        deviceId: device.deviceId,
        deviceName: device.deviceName || device.deviceId,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[relay] Could not remember agent ${device.deviceId}: ${err.message}`);
  }
}

function persistBrowserAuthorization(userId, browserId, deviceId) {
  if (!PERSIST_PAIRINGS) return;
  if (!pairingsUseDatabase()) {
    persistPairings();
    return;
  }

  try {
    const db = openAdminDatabase();
    try {
      const device = devices.get(scopedDeviceKey(userId, deviceId));
      require('./db').upsertBrowserPairing(db, {
        userId,
        deviceId,
        deviceName: device?.deviceName || deviceId,
        browserId,
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[relay] Could not persist browser pairing: ${err.message}`);
  }
}

function persistBrowserRevocation(userId, browserId, deviceId) {
  if (!PERSIST_PAIRINGS) return;
  if (!pairingsUseDatabase()) {
    persistPairings();
    return;
  }

  try {
    const db = openAdminDatabase();
    try {
      require('./db').revokeBrowserPairing(db, { userId, browserId, deviceId });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[relay] Could not revoke browser pairing: ${err.message}`);
  }
}

function generatePairingCode() {
  purgeExpiredPairingCodes();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    const code = `${raw.slice(0, 3)}-${raw.slice(3)}`;
    if (!pairingCodes.has(code)) return code;
  }
  return `${Date.now().toString(36).slice(-3)}-${crypto.randomBytes(2).toString('hex').slice(0, 3)}`.toUpperCase();
}

function normalizePairingCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

function purgeExpiredPairingCodes() {
  const now = Date.now();
  for (const [code, pairing] of pairingCodes.entries()) {
    if (pairing.expiresAtMs <= now) pairingCodes.delete(code);
  }
}

function deletePairingCodesForDevice(userId, deviceId) {
  for (const [code, pairing] of pairingCodes.entries()) {
    if (pairing.userId === userId && pairing.deviceId === deviceId) pairingCodes.delete(code);
  }
}

function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    online: Boolean(device.online),
  };
}

function closeProtocol(ws, reason) {
  try {
    ws.close(1008, reason);
  } catch (_) {
    ws.terminate();
  }
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendBinary(ws, frame) {
  if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
}

function createRateState() {
  return {
    windowStartMs: Date.now(),
    messages: 0,
    commands: 0,
    pairings: 0,
  };
}

function allowRate(ws, client, bucket, limit) {
  // This is intentionally simple per-connection pressure control. It is not a
  // replacement for account-level abuse protection, but it stops accidental or
  // trivial floods before they reach the agent.
  const now = Date.now();
  if (!client.rate || now - client.rate.windowStartMs > RATE_WINDOW_MS) {
    client.rate = createRateState();
  }

  client.rate[bucket] = (client.rate[bucket] || 0) + 1;
  if (client.rate[bucket] <= limit) return true;

  send(ws, createRemoteMessage(MESSAGE_TYPES.RELAY_ERROR, RATE_LIMIT_ERRORS[bucket] || RATE_LIMIT_ERRORS.messages));
  return false;
}

function sendAdminHtml(res) {
  fs.readFile(ADMIN_HTML_FILE, (err, html) => {
    if (err) {
      res.writeHead(500, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('Contrail admin UI is unavailable.');
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  });
}

function authorizeAdminRequest(req) {
  if (!ADMIN_TOKEN_HASH) return { ok: false, status: 403, error: 'admin token is not configured' };

  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !verifySecret(match[1].trim(), ADMIN_TOKEN_HASH)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  return { ok: true };
}

function withAccountDatabase(callback) {
  const db = openAdminDatabase();
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createAccountSession(db, req, userId) {
  const sessionToken = generateRelayToken();
  const expiresAt = new Date(Date.now() + ACCOUNT_SESSION_TTL_MS).toISOString();
  const browserId = readBrowserIdFromBodyHint(req);
  const browserIdHash = browserId && isTokenLike(browserId)
    ? require('./db').hashBrowserForUser(userId, browserId)
    : '';

  const session = require('./db').createBrowserSession(db, {
    userId,
    sessionToken,
    expiresAt,
    browserIdHash,
    ipAddress: getRequestIp(req),
    userAgent: req.headers['user-agent'] || '',
  });

  return {
    ...session,
    userName: session.displayName || session.userId,
    sessionToken,
  };
}

function getAccountSession(req) {
  const token = getSessionTokenFromRequest(req);
  if (!token || RELAY_AUTH_MODE === AUTH_MODE_ENV) return null;

  try {
    const db = openAdminDatabase();
    try {
      const session = require('./db').getBrowserSession(db, token);
      if (!session) return null;
      return {
        userId: session.userId,
        userName: session.displayName || session.userId,
        expiresAt: session.expiresAt,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[relay-account] Could not read browser session: ${err.message}`);
    return null;
  }
}

function findRelayUserBySession(req) {
  const session = getAccountSession(req);
  if (!session) return null;
  return {
    userId: session.userId,
    userName: session.userName || session.userId,
  };
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[ACCOUNT_SESSION_COOKIE] || '';
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function sessionCookieHeaders(req, sessionToken, expiresAt) {
  return {
    'set-cookie': buildSessionCookie(req, sessionToken, {
      maxAgeSeconds: Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
    }),
  };
}

function clearSessionCookieHeaders(req) {
  return {
    'set-cookie': buildSessionCookie(req, '', { maxAgeSeconds: 0 }),
  };
}

function buildSessionCookie(req, value, options = {}) {
  const parts = [
    `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Number(options.maxAgeSeconds || 0))}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function isSecureRequest(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function publicAccountUser(session) {
  return {
    userId: session.userId,
    userName: session.userName || session.displayName || session.userId,
    expiresAt: session.expiresAt,
  };
}

class AccountApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AccountApiError';
    this.status = status;
    this.code = code;
  }
}

function isAccountApiError(err) {
  return err instanceof AccountApiError;
}

function accountApiError(status, code, message) {
  return new AccountApiError(status, code, message);
}

function requireAccountUserId(value) {
  const userId = String(value || '').trim().toLowerCase();
  if (!isUserId(userId)) {
    throw accountApiError(
      400,
      'invalid_username',
      'Use a 2-48 character username: letters, numbers, dot, underscore, or dash.'
    );
  }
  return userId;
}

function requireAccountDisplayName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) {
    throw accountApiError(400, 'invalid_display_name', 'Display name must be 1-80 characters.');
  }
  return text;
}

function requireAccountPassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 256) {
    throw accountApiError(400, 'invalid_password', 'Password must be 10-256 characters.');
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password || ''), parts[1], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readBrowserIdFromBodyHint(_req) {
  // Reserved for a later account/devices screen. Sessions work without this
  // because WebSocket browser ids are still supplied during /ws connect.
  return '';
}

function closeAgentClientsForUser(userId, reason) {
  for (const [ws, client] of clients.entries()) {
    if (client.userId !== userId || client.source !== MESSAGE_SOURCES.AGENT) continue;
    try {
      ws.close(1008, reason);
    } catch (_) {
      ws.terminate();
    }
    removeClient(ws);
  }
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('admin request body is too large');
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function withAdminDatabase(callback) {
  const db = openAdminDatabase();
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function openAdminDatabase() {
  return require('./db').openRelayDatabase();
}

function defaultRelayDatabasePath() {
  return require('./db').defaultDatabasePath();
}

function listAdminRelayUsers(db) {
  return require('./db').listRelayUserSummaries(db).map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    tokenCount: row.tokenCount || 0,
    activeTokenCount: row.activeTokenCount || 0,
    activeTokenPrefixes: row.activeTokenPrefixes ? row.activeTokenPrefixes.split(',') : [],
  }));
}

function listAdminRelayDevices(db) {
  const onlineDevices = new Map();
  for (const device of devices.values()) {
    onlineDevices.set(device.key, {
      connectedAt: new Date(device.connectedAt).toISOString(),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
    });
  }

  return require('./db').listRelayAgentSummaries(db).map((row) => {
    const online = onlineDevices.get(scopedDeviceKey(row.userId, row.deviceId));
    return {
      userId: row.userId,
      displayName: row.displayName,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      online: Boolean(online),
      connectedAt: online?.connectedAt || null,
      lastSeenAt: online?.lastSeenAt || row.lastSeenAt,
      firstSeenAt: row.firstSeenAt,
      disabledAt: row.disabledAt,
      activePairingCount: row.activePairingCount || 0,
    };
  });
}

function listAdminRelayPairings(db) {
  return require('./db').listActiveBrowserPairings(db).map((row) => ({
    pairingId: row.pairingId,
    userId: row.userId,
    displayName: row.displayName,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    browserLabel: row.browserLabel,
    browserHashPrefix: row.browserIdHash.slice(0, 12),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    online: devices.has(scopedDeviceKey(row.userId, row.deviceId)),
  }));
}

function listAdminAuditEvents(db) {
  return require('./db').listAuditEvents(db, { limit: 120 }).map((row) => ({
    auditId: row.auditId,
    userId: row.userId || null,
    actorType: row.actorType,
    actorId: row.actorId,
    eventType: row.eventType,
    ipAddress: row.ipAddress,
    targetAgentId: row.targetAgentId,
    targetBrowserPairingId: row.targetBrowserPairingId,
    commandType: row.commandType,
    createdAt: row.createdAt,
    metadata: parseAuditMetadata(row.metadataJson),
  }));
}

function getAdminRelayUser(db, userId) {
  return require('./db').getRelayUser(db, userId);
}

function importAdminRelayUserToken(db, input) {
  return require('./db').importRelayUserToken(db, {
    ...input,
    tokenName: 'Relay preview token',
  });
}

function revokeAdminRelayUserTokens(db, input) {
  return require('./db').revokeRelayUserTokens(db, {
    ...input,
    tokenName: 'Relay preview token',
  });
}

function setAdminRelayUserDisabled(db, userId, disabled) {
  return require('./db').setRelayUserDisabled(db, userId, disabled);
}

function deleteAdminRelayUser(db, userId) {
  return require('./db').deleteRelayUser(db, userId);
}

function revokeAdminRelayPairing(db, pairingId) {
  return require('./db').revokeBrowserPairingById(db, pairingId);
}

function insertAdminAuditEvent(db, req, input) {
  try {
    require('./db').insertAuditEvent(db, {
      ...input,
      actorType: 'admin',
      actorId: 'admin-token',
      ipAddress: getRequestIp(req),
    });
  } catch (err) {
    console.warn(`[relay-audit] Could not write admin audit event: ${err.message}`);
  }
}

function insertAccountAuditEvent(db, req, input) {
  try {
    require('./db').insertAuditEvent(db, {
      ...input,
      actorType: 'account',
      actorId: input.actorId || input.userId,
      ipAddress: getRequestIp(req),
    });
  } catch (err) {
    console.warn(`[relay-audit] Could not write account audit event: ${err.message}`);
  }
}

function recordAuditEvent(input) {
  if (RELAY_AUTH_MODE === AUTH_MODE_ENV) return;

  try {
    const db = openAdminDatabase();
    try {
      require('./db').insertAuditEvent(db, input);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[relay-audit] Could not write audit event: ${err.message}`);
  }
}

function parseAuditMetadata(metadataJson) {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function reloadRelayUsers() {
  const refreshed = loadRelayUsers();
  relayUsers.clear();
  for (const [userId, user] of refreshed.entries()) relayUsers.set(userId, user);
}

function closeClientsForUser(userId, reason) {
  for (const [ws, client] of clients.entries()) {
    if (client.userId !== userId) continue;
    try {
      ws.close(1008, reason);
    } catch (_) {
      ws.terminate();
    }
    removeClient(ws);
  }
}

function disconnectRevokedPairingClients(userId, browserHash, deviceId) {
  for (const [ws, client] of clients.entries()) {
    if (
      client.userId !== userId
      || client.source !== MESSAGE_SOURCES.BROWSER
      || !client.browserId
      || browserAuthorizationKey(userId, client.browserId) !== browserHash
    ) {
      continue;
    }

    if (client.activeTxDeviceId === deviceId) stopBrowserTx(client, 'remote tx stopped by pairing revoke');
    if (client.selectedDeviceId === deviceId) client.selectedDeviceId = '';
    send(ws, createRemoteMessage(MESSAGE_TYPES.PAIRING_REVOKED, { deviceId }, `admin-revoked-${deviceId}`));
  }
}

function requireAdminUserId(userId) {
  const value = String(userId || '').trim();
  if (!isUserId(value)) throw new Error('invalid user id');
  return value;
}

function getRequestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function generateRelayToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendOptions(req, res) {
  // The hosted webapp uses this for a lightweight relay preflight. Only
  // allowlisted origins receive CORS headers, matching the WebSocket gate.
  res.writeHead(204, {
    ...corsHeaders(req),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
  });
  res.end();
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...corsHeaders(req),
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

function loadRelayUsers() {
  const users = new Map();

  if (RELAY_AUTH_MODE === AUTH_MODE_SQLITE || RELAY_AUTH_MODE === AUTH_MODE_SQLITE_FALLBACK) {
    loadDatabaseRelayUsers(users);
  }
  if (RELAY_AUTH_MODE === AUTH_MODE_ENV || RELAY_AUTH_MODE === AUTH_MODE_SQLITE_FALLBACK) {
    loadEnvRelayUsers(users);
  }

  return users;
}

function loadDatabaseRelayUsers(users) {
  let db;
  try {
    // Load SQLite only when the selected auth mode needs it. This keeps the
    // simple/local .env path operationally separate from the database path.
    const {
      listActiveRelayTokenUsers,
      openRelayDatabase,
    } = require('./db');

    db = openRelayDatabase();
    for (const row of listActiveRelayTokenUsers(db)) {
      if (!isUserId(row.userId) || !row.tokenHash) continue;
      addRelayUserToken(users, {
        userId: row.userId,
        userName: row.userName || row.userId,
        tokenHash: Buffer.from(row.tokenHash, 'hex'),
      });
    }
  } catch (err) {
    console.error(`[relay] Could not load relay users from SQLite: ${err.message}`);
    process.exit(1);
  } finally {
    if (db) db.close();
  }
}

function loadEnvRelayUsers(users) {
  const userEntries = parseList(process.env.CONTRAIL_RELAY_USERS || '');
  const seenEnvUsers = new Set();

  for (const entry of userEntries) {
    const separator = entry.includes('=') ? '=' : ':';
    const index = entry.indexOf(separator);
    if (index <= 0 || index >= entry.length - 1) {
      console.error(`[relay] Invalid CONTRAIL_RELAY_USERS entry: ${entry}`);
      process.exit(1);
    }

    const userId = entry.slice(0, index).trim();
    const token = entry.slice(index + 1).trim();
    if (!isUserId(userId) || !token) {
      console.error(`[relay] Invalid relay user or token in CONTRAIL_RELAY_USERS entry: ${entry}`);
      process.exit(1);
    }
    if (seenEnvUsers.has(userId)) {
      console.error(`[relay] Duplicate relay user in CONTRAIL_RELAY_USERS: ${userId}`);
      process.exit(1);
    }
    seenEnvUsers.add(userId);

    addRelayUserToken(users, {
      userId,
      userName: userId,
      tokenHash: hashSecret(token),
    });
  }

  const legacyToken = process.env.CONTRAIL_RELAY_TOKEN || '';
  if (legacyToken) {
    const envDefinesDefault = userEntries.some((entry) => {
      const separator = entry.includes('=') ? '=' : ':';
      const index = entry.indexOf(separator);
      return index > 0 && entry.slice(0, index).trim() === DEFAULT_USER_ID;
    });
    if (envDefinesDefault) {
      console.error(`[relay] CONTRAIL_RELAY_USERS cannot also define the reserved user id "${DEFAULT_USER_ID}" when CONTRAIL_RELAY_TOKEN is set.`);
      process.exit(1);
    }
    addRelayUserToken(users, {
      userId: DEFAULT_USER_ID,
      userName: 'Default',
      tokenHash: hashSecret(legacyToken),
    });
  }
}

function findRelayUserByToken(token) {
  if (!token) return null;
  for (const user of relayUsers.values()) {
    const tokenHashes = user.tokenHashes || [user.tokenHash];
    if (tokenHashes.some((expectedHash) => verifySecret(token, expectedHash))) return user;
  }
  return null;
}

function addRelayUserToken(users, input) {
  const existing = users.get(input.userId);
  if (existing) {
    existing.tokenHashes.push(input.tokenHash);
    return;
  }

  users.set(input.userId, {
    userId: input.userId,
    userName: input.userName || input.userId,
    tokenHashes: [input.tokenHash],
  });
}

function parseRelayAuthMode(env) {
  const explicit = String(env.CONTRAIL_RELAY_AUTH_MODE || '').trim().toLowerCase();
  if (!explicit) return AUTH_MODE_ENV;
  if ([AUTH_MODE_ENV, AUTH_MODE_SQLITE_FALLBACK, AUTH_MODE_SQLITE].includes(explicit)) return explicit;

  console.error(`[relay] Invalid CONTRAIL_RELAY_AUTH_MODE "${explicit}". Use env, sqlite-fallback, or sqlite.`);
  process.exit(1);
}

function parseList(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function isTokenLike(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(value);
}

function isUserId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{2,48}$/.test(value);
}

function scopedDeviceKey(userId, deviceId) {
  return `${userId}:${deviceId}`;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function verifySecret(value, expectedHash) {
  const actual = hashSecret(value);
  return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
}

function deny(status, reason) {
  return { ok: false, status, reason };
}

server.listen(PORT, HOST, () => {
  console.log(`[relay] Listening on http://${HOST}:${PORT}`);
  console.log(`[relay] Allowed origins: ${ALLOWED_ORIGINS.join(', ') || '(none)'}`);
  console.log(`[relay] Auth mode: ${RELAY_AUTH_MODE}`);
  console.log(`[relay] Configured relay users: ${relayUsers.size}`);
  console.log(`[relay] Browser pairing: ${REQUIRE_PAIRING ? 'required' : 'disabled'}`);
});
