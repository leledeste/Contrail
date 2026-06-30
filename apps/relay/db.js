'use strict';

// SQLite support for the relay dashboard/control-plane database.
//
// This module is intentionally small and synchronous. Relay database writes are
// low-frequency admin/control events, while live audio and WebSocket routing
// stay in memory and never touch SQLite.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openRelayDatabase(options = {}) {
  const filename = path.resolve(options.filename || defaultDatabasePath());
  fs.mkdirSync(path.dirname(filename), { recursive: true });

  const db = new Database(filename);
  configureDatabase(db);
  applyMigrations(db, options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  return db;
}

function defaultDatabasePath(env = process.env) {
  const configured = String(env.CONTRAIL_RELAY_DATABASE || '').trim();
  if (configured) return configured;

  const dataDir = String(env.CONTRAIL_RELAY_DATA_DIR || '.contrail-relay').trim();
  return path.join(dataDir || '.contrail-relay', 'contrail.db');
}

function configureDatabase(db) {
  // WAL keeps readers responsive while occasional admin writes happen. Foreign
  // keys are off by default in SQLite, so every connection must enable them.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

function applyMigrations(db, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = listMigrations(migrationsDir);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    runMigration(db, migration);
    applied.add(migration.version);
  }
}

function listMigrations(migrationsDir) {
  const files = fs.readdirSync(migrationsDir)
    .map((file) => {
      const match = file.match(/^(\d+)_([A-Za-z0-9_-]+)\.sql$/);
      if (!match) return null;
      return {
        version: Number(match[1]),
        name: match[2],
        file,
        path: path.join(migrationsDir, file),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);

  for (let index = 1; index < files.length; index += 1) {
    if (files[index].version === files[index - 1].version) {
      throw new Error(`Duplicate migration version: ${files[index].version}`);
    }
  }

  return files;
}

function runMigration(db, migration) {
  const sql = fs.readFileSync(migration.path, 'utf8');
  const apply = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
      .run(migration.version, migration.name);
  });
  apply();
}

function importRelayUserToken(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const displayName = requireDbText(input.displayName || input.userId, 'displayName');
  const token = requireDbText(input.token, 'token');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const dbUserId = relayUserDbId(userId);

  const importToken = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, username, display_name, created_at)
      VALUES (@id, @username, @displayName, @now)
      ON CONFLICT(username) DO UPDATE SET
        display_name = excluded.display_name,
        disabled_at = NULL
    `).run({
      id: dbUserId,
      username: userId,
      displayName,
      now,
    });

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(userId);
    const existing = db.prepare(`
      SELECT id, token_hash
      FROM agent_tokens
      WHERE user_id = ? AND name = ? AND revoked_at IS NULL
      ORDER BY created_at DESC
    `).all(user.id, input.tokenName || 'Relay preview token');

    if (existing.some((row) => row.token_hash === tokenHash)) {
      return { action: 'unchanged', userId, tokenPrefix: tokenPrefix(token) };
    }

    db.prepare(`
      UPDATE agent_tokens
      SET revoked_at = @now
      WHERE user_id = @userId AND name = @name AND revoked_at IS NULL
    `).run({
      now,
      userId: user.id,
      name: input.tokenName || 'Relay preview token',
    });

    db.prepare(`
      INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash, created_at)
      VALUES (@id, @userId, @name, @tokenPrefix, @tokenHash, @now)
    `).run({
      id: `tok_${crypto.randomUUID()}`,
      userId: user.id,
      name: input.tokenName || 'Relay preview token',
      tokenPrefix: tokenPrefix(token),
      tokenHash,
      now,
    });

    return {
      action: existing.length ? 'rotated' : 'created',
      userId,
      tokenPrefix: tokenPrefix(token),
    };
  });

  return importToken();
}

function createRelayAccount(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const displayName = requireDbText(input.displayName || input.userId, 'displayName');
  const passwordHash = requireDbText(input.passwordHash, 'passwordHash');
  const token = requireDbText(input.token, 'token');
  const tokenHash = hashToken(token);
  const now = new Date().toISOString();
  const dbUserId = relayUserDbId(userId);

  const createAccount = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(userId);
    if (existing) throw new Error('user already exists');

    db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, created_at)
      VALUES (@id, @username, @displayName, @passwordHash, @now)
    `).run({
      id: dbUserId,
      username: userId,
      displayName,
      passwordHash,
      now,
    });

    db.prepare(`
      INSERT INTO agent_tokens (id, user_id, name, token_prefix, token_hash, created_at)
      VALUES (@id, @userId, @name, @tokenPrefix, @tokenHash, @now)
    `).run({
      id: `tok_${crypto.randomUUID()}`,
      userId: dbUserId,
      name: input.tokenName || 'Relay preview token',
      tokenPrefix: tokenPrefix(token),
      tokenHash,
      now,
    });

    return {
      userId,
      displayName,
      tokenPrefix: tokenPrefix(token),
    };
  });

  return createAccount();
}

function listImportedRelayUsers(db) {
  return db.prepare(`
    SELECT
      users.username,
      users.display_name AS displayName,
      agent_tokens.name AS tokenName,
      agent_tokens.token_prefix AS tokenPrefix,
      agent_tokens.created_at AS createdAt,
      agent_tokens.revoked_at AS revokedAt
    FROM users
    LEFT JOIN agent_tokens ON agent_tokens.user_id = users.id
    ORDER BY users.username, agent_tokens.created_at
  `).all();
}

function listRelayUserSummaries(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS displayName,
      users.created_at AS createdAt,
      users.disabled_at AS disabledAt,
      COUNT(agent_tokens.id) AS tokenCount,
      SUM(CASE WHEN agent_tokens.id IS NOT NULL AND agent_tokens.revoked_at IS NULL THEN 1 ELSE 0 END) AS activeTokenCount,
      GROUP_CONCAT(CASE WHEN agent_tokens.revoked_at IS NULL THEN agent_tokens.token_prefix END, ',') AS activeTokenPrefixes
    FROM users
    LEFT JOIN agent_tokens ON agent_tokens.user_id = users.id
    GROUP BY users.id
    ORDER BY users.username
  `).all();
}

function listActiveRelayTokenUsers(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS userName,
      agent_tokens.token_hash AS tokenHash
    FROM users
    JOIN agent_tokens ON agent_tokens.user_id = users.id
    WHERE users.disabled_at IS NULL
      AND agent_tokens.revoked_at IS NULL
    ORDER BY users.username, agent_tokens.created_at
  `).all();
}

function upsertRelayAgent(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const name = requireDbText(input.name || input.deviceName || deviceId, 'deviceName');
  const now = new Date().toISOString();
  const user = ensureRelayUser(db, userId, input.userName || userId);
  const agentId = relayAgentDbId(user.id, deviceId);

  db.prepare(`
    INSERT INTO agents (id, user_id, token_id, device_id, name, first_seen_at, last_seen_at)
    VALUES (@id, @userId, NULL, @deviceId, @name, @now, @now)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      name = excluded.name,
      last_seen_at = excluded.last_seen_at,
      disabled_at = NULL
  `).run({
    id: agentId,
    userId: user.id,
    deviceId,
    name,
    now,
  });

  return {
    agentId,
    userId,
    deviceId,
    name,
  };
}

function upsertBrowserPairing(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const browserId = requireDbText(input.browserId, 'browserId');
  const browserLabel = String(input.browserLabel || '').trim() || null;
  const now = new Date().toISOString();
  const agent = upsertRelayAgent(db, input);
  const user = requireRelayUser(db, userId);
  const browserIdHash = hashBrowserForUser(userId, browserId);

  db.prepare(`
    INSERT INTO browser_pairings (
      id,
      user_id,
      agent_id,
      browser_id_hash,
      browser_label,
      created_at,
      last_used_at
    )
    VALUES (@id, @userId, @agentId, @browserIdHash, @browserLabel, @now, @now)
    ON CONFLICT(user_id, agent_id, browser_id_hash) DO UPDATE SET
      browser_label = COALESCE(excluded.browser_label, browser_pairings.browser_label),
      last_used_at = excluded.last_used_at,
      revoked_at = NULL
  `).run({
    id: `pair_${crypto.randomUUID()}`,
    userId: user.id,
    agentId: agent.agentId,
    browserIdHash,
    browserLabel,
    now,
  });

  return {
    userId,
    deviceId,
    browserIdHash,
  };
}

function revokeBrowserPairing(db, input) {
  const userId = requireDbText(input.userId, 'userId');
  const deviceId = requireDbText(input.deviceId, 'deviceId');
  const browserId = requireDbText(input.browserId, 'browserId');
  const user = requireRelayUser(db, userId);
  const agent = getRelayAgent(db, user.id, deviceId);
  if (!agent) return { userId, deviceId, browserIdHash: hashBrowserForUser(userId, browserId), count: 0 };

  const browserIdHash = hashBrowserForUser(userId, browserId);
  const result = db.prepare(`
    UPDATE browser_pairings
    SET revoked_at = @now
    WHERE user_id = @userId
      AND agent_id = @agentId
      AND browser_id_hash = @browserIdHash
      AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    userId: user.id,
    agentId: agent.id,
    browserIdHash,
  });

  return { userId, deviceId, browserIdHash, count: result.changes };
}

function revokeBrowserPairingById(db, pairingId) {
  const pairing = getBrowserPairingById(db, pairingId);
  if (!pairing) return null;

  const result = db.prepare(`
    UPDATE browser_pairings
    SET revoked_at = @now
    WHERE id = @pairingId AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    pairingId,
  });

  return {
    ...pairing,
    count: result.changes,
  };
}

function listActiveBrowserPairings(db) {
  return db.prepare(`
    SELECT
      browser_pairings.id AS pairingId,
      users.username AS userId,
      users.display_name AS displayName,
      agents.device_id AS deviceId,
      agents.name AS deviceName,
      browser_pairings.browser_id_hash AS browserIdHash,
      browser_pairings.browser_label AS browserLabel,
      browser_pairings.created_at AS createdAt,
      browser_pairings.last_used_at AS lastUsedAt
    FROM browser_pairings
    JOIN users ON users.id = browser_pairings.user_id
    JOIN agents ON agents.id = browser_pairings.agent_id
    WHERE users.disabled_at IS NULL
      AND agents.disabled_at IS NULL
      AND browser_pairings.revoked_at IS NULL
    ORDER BY users.username, agents.name, browser_pairings.last_used_at DESC
  `).all();
}

function listRelayAgentSummaries(db) {
  return db.prepare(`
    SELECT
      users.username AS userId,
      users.display_name AS displayName,
      agents.device_id AS deviceId,
      agents.name AS deviceName,
      agents.first_seen_at AS firstSeenAt,
      agents.last_seen_at AS lastSeenAt,
      agents.disabled_at AS disabledAt,
      COUNT(browser_pairings.id) AS activePairingCount
    FROM agents
    JOIN users ON users.id = agents.user_id
    LEFT JOIN browser_pairings
      ON browser_pairings.agent_id = agents.id
      AND browser_pairings.revoked_at IS NULL
    GROUP BY agents.id
    ORDER BY users.username, agents.name
  `).all();
}

function insertAuditEvent(db, input) {
  const eventType = requireDbText(input.eventType, 'eventType');
  const actorType = requireDbText(input.actorType, 'actorType');
  const user = input.userId ? getRelayUser(db, input.userId) : null;
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? JSON.stringify(input.metadata)
    : null;

  db.prepare(`
    INSERT INTO audit_events (
      id,
      user_id,
      actor_type,
      actor_id,
      event_type,
      ip_address,
      target_agent_id,
      target_browser_pairing_id,
      command_type,
      created_at,
      metadata_json
    )
    VALUES (
      @id,
      @userId,
      @actorType,
      @actorId,
      @eventType,
      @ipAddress,
      @targetAgentId,
      @targetBrowserPairingId,
      @commandType,
      @now,
      @metadataJson
    )
  `).run({
    id: `aud_${crypto.randomUUID()}`,
    userId: user?.id || null,
    actorType,
    actorId: optionalDbText(input.actorId),
    eventType,
    ipAddress: optionalDbText(input.ipAddress),
    targetAgentId: optionalDbText(input.targetAgentId),
    targetBrowserPairingId: optionalDbText(input.targetBrowserPairingId),
    commandType: optionalDbText(input.commandType),
    now: new Date().toISOString(),
    metadataJson: metadata,
  });
}

function listAuditEvents(db, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  return db.prepare(`
    SELECT
      audit_events.id AS auditId,
      users.username AS userId,
      audit_events.actor_type AS actorType,
      audit_events.actor_id AS actorId,
      audit_events.event_type AS eventType,
      audit_events.ip_address AS ipAddress,
      audit_events.target_agent_id AS targetAgentId,
      audit_events.target_browser_pairing_id AS targetBrowserPairingId,
      audit_events.command_type AS commandType,
      audit_events.created_at AS createdAt,
      audit_events.metadata_json AS metadataJson
    FROM audit_events
    LEFT JOIN users ON users.id = audit_events.user_id
    ORDER BY audit_events.created_at DESC
    LIMIT ?
  `).all(limit);
}

function getRelayUser(db, userId) {
  const username = requireDbText(userId, 'userId');
  return db.prepare(`
    SELECT id, username AS userId, display_name AS displayName, created_at AS createdAt, disabled_at AS disabledAt
    FROM users
    WHERE username = ?
  `).get(username) || null;
}

function getRelayUserCredentials(db, userId) {
  const username = requireDbText(userId, 'userId');
  return db.prepare(`
    SELECT
      id,
      username AS userId,
      display_name AS displayName,
      password_hash AS passwordHash,
      created_at AS createdAt,
      disabled_at AS disabledAt
    FROM users
    WHERE username = ?
  `).get(username) || null;
}

function ensureRelayUser(db, userId, displayName) {
  const username = requireDbText(userId, 'userId');
  const name = requireDbText(displayName || username, 'displayName');
  const dbUserId = relayUserDbId(username);

  db.prepare(`
    INSERT INTO users (id, username, display_name, created_at)
    VALUES (@id, @username, @displayName, @now)
    ON CONFLICT(username) DO NOTHING
  `).run({
    id: dbUserId,
    username,
    displayName: name,
    now: new Date().toISOString(),
  });

  return requireRelayUser(db, username);
}

function setRelayUserDisabled(db, userId, disabled) {
  const user = requireRelayUser(db, userId);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
    .run(disabled ? now : null, user.id);

  return {
    userId: user.userId,
    action: disabled ? 'disabled' : 'enabled',
  };
}

function revokeRelayUserTokens(db, input) {
  const user = requireRelayUser(db, input.userId);
  const tokenName = input.tokenName ? requireDbText(input.tokenName, 'tokenName') : null;
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE agent_tokens
    SET revoked_at = @now
    WHERE user_id = @userId
      AND revoked_at IS NULL
      AND (@tokenName IS NULL OR name = @tokenName)
  `).run({
    now,
    userId: user.id,
    tokenName,
  });

  return {
    userId: user.userId,
    action: 'revoked',
    count: result.changes,
  };
}

function deleteRelayUser(db, userId) {
  const user = requireRelayUser(db, userId);
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return {
    userId: user.userId,
    action: 'deleted',
    count: result.changes,
  };
}

function createBrowserSession(db, input) {
  const user = requireRelayUser(db, input.userId);
  const sessionToken = requireDbText(input.sessionToken, 'sessionToken');
  const expiresAt = requireDbText(input.expiresAt, 'expiresAt');
  const now = new Date().toISOString();
  const sessionHash = hashToken(sessionToken);

  db.prepare(`
    INSERT INTO browser_sessions (
      id,
      user_id,
      session_hash,
      browser_id_hash,
      created_at,
      last_seen_at,
      expires_at,
      ip_address,
      user_agent
    )
    VALUES (
      @id,
      @userId,
      @sessionHash,
      @browserIdHash,
      @now,
      @now,
      @expiresAt,
      @ipAddress,
      @userAgent
    )
  `).run({
    id: `ses_${crypto.randomUUID()}`,
    userId: user.id,
    sessionHash,
    browserIdHash: optionalDbText(input.browserIdHash),
    now,
    expiresAt,
    ipAddress: optionalDbText(input.ipAddress),
    userAgent: optionalDbText(input.userAgent),
  });

  return {
    userId: user.userId,
    displayName: user.displayName,
    expiresAt,
  };
}

function getBrowserSession(db, sessionToken) {
  const token = requireDbText(sessionToken, 'sessionToken');
  const sessionHash = hashToken(token);
  const now = new Date().toISOString();
  const session = db.prepare(`
    SELECT
      browser_sessions.id AS sessionId,
      users.username AS userId,
      users.display_name AS displayName,
      browser_sessions.expires_at AS expiresAt
    FROM browser_sessions
    JOIN users ON users.id = browser_sessions.user_id
    WHERE browser_sessions.session_hash = ?
      AND browser_sessions.revoked_at IS NULL
      AND browser_sessions.expires_at > ?
      AND users.disabled_at IS NULL
  `).get(sessionHash, now) || null;

  if (!session) return null;
  db.prepare('UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?')
    .run(now, session.sessionId);
  return session;
}

function revokeBrowserSession(db, sessionToken) {
  const token = requireDbText(sessionToken, 'sessionToken');
  const result = db.prepare(`
    UPDATE browser_sessions
    SET revoked_at = @now
    WHERE session_hash = @sessionHash AND revoked_at IS NULL
  `).run({
    now: new Date().toISOString(),
    sessionHash: hashToken(token),
  });

  return { count: result.changes };
}

function requireRelayUser(db, userId) {
  const user = getRelayUser(db, userId);
  if (!user) throw new Error(`Relay user not found: ${userId}`);
  return user;
}

function getRelayAgent(db, dbUserId, deviceId) {
  return db.prepare(`
    SELECT id, device_id AS deviceId, name
    FROM agents
    WHERE user_id = ? AND device_id = ?
  `).get(dbUserId, deviceId) || null;
}

function getBrowserPairingById(db, pairingId) {
  const id = requireDbText(pairingId, 'pairingId');
  return db.prepare(`
    SELECT
      browser_pairings.id AS pairingId,
      users.username AS userId,
      agents.device_id AS deviceId,
      browser_pairings.browser_id_hash AS browserIdHash
    FROM browser_pairings
    JOIN users ON users.id = browser_pairings.user_id
    JOIN agents ON agents.id = browser_pairings.agent_id
    WHERE browser_pairings.id = ?
  `).get(id) || null;
}

function relayUserDbId(userId) {
  return `usr_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

function relayAgentDbId(dbUserId, deviceId) {
  return `agt_${crypto.createHash('sha256').update(`${dbUserId}:${deviceId}`).digest('hex').slice(0, 24)}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashBrowserForUser(userId, browserId) {
  return hashToken(`${userId}:${browserId}`);
}

function tokenPrefix(token) {
  return String(token).slice(0, 8);
}

function requireDbText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalDbText(value) {
  const text = String(value || '').trim();
  return text || null;
}

module.exports = {
  openRelayDatabase,
  defaultDatabasePath,
  configureDatabase,
  applyMigrations,
  listMigrations,
  createRelayAccount,
  importRelayUserToken,
  listImportedRelayUsers,
  listRelayUserSummaries,
  listActiveRelayTokenUsers,
  upsertRelayAgent,
  upsertBrowserPairing,
  revokeBrowserPairing,
  revokeBrowserPairingById,
  listActiveBrowserPairings,
  listRelayAgentSummaries,
  insertAuditEvent,
  listAuditEvents,
  getRelayUser,
  getRelayUserCredentials,
  setRelayUserDisabled,
  revokeRelayUserTokens,
  deleteRelayUser,
  createBrowserSession,
  getBrowserSession,
  revokeBrowserSession,
  hashToken,
  hashBrowserForUser,
  tokenPrefix,
};
