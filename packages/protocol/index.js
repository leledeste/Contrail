'use strict';

// Shared protocol rules for the planned Contrail Remote relay.
// This module has no external dependencies so the agent, relay, tests, and
// eventually browser tooling can reuse the same allowlist.

const REMOTE_PROTOCOL_VERSION = 1;
const MAX_JSON_MESSAGE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 1024;

const MESSAGE_SOURCES = Object.freeze({
  BROWSER: 'browser',
  AGENT: 'agent',
  RELAY: 'relay',
});

const MESSAGE_TYPES = Object.freeze({
  PING: 'ping',
  PONG: 'pong',
  DEVICE_LIST: 'device.list',
  DEVICE_SELECT: 'device.select',
  DEVICE_STATE: 'device.state',
  PAIRING_BEGIN: 'pairing.begin',
  PAIRING_CODE: 'pairing.code',
  PAIRING_CONFIRM: 'pairing.confirm',
  PAIRING_REVOKE: 'pairing.revoke',
  PAIRING_REVOKED: 'pairing.revoked',
  RELAY_IDENTITY: 'relay.identity',
  RELAY_ERROR: 'relay.error',
  AGENT_HELLO: 'agent.hello',
  AGENT_STATUS: 'agent.status',
  RADIO_SET: 'radio.set',
  RADIO_STATE: 'radio.state',
  STATIONS_STATE: 'stations.state',
  CHAT_SEND: 'chat.send',
  CHAT_MESSAGE: 'chat.message',
  WEATHER_REQUEST: 'weather.request',
  ATIS_REQUEST: 'atis.request',
  XPDR_SET_SQUAWK: 'xpdr.setSquawk',
  XPDR_SET_MODE: 'xpdr.setMode',
  XPDR_IDENT: 'xpdr.ident',
  TX_START: 'tx.start',
  TX_STOP: 'tx.stop',
  MONITOR_START: 'monitor.start',
  MONITOR_STOP: 'monitor.stop',
});

const SOURCE_RULES = Object.freeze({
  [MESSAGE_TYPES.PING]: [MESSAGE_SOURCES.BROWSER, MESSAGE_SOURCES.AGENT, MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.PONG]: [MESSAGE_SOURCES.BROWSER, MESSAGE_SOURCES.AGENT, MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.DEVICE_LIST]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.DEVICE_SELECT]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.DEVICE_STATE]: [MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.PAIRING_BEGIN]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.PAIRING_CODE]: [MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.PAIRING_CONFIRM]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.PAIRING_REVOKE]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.PAIRING_REVOKED]: [MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.RELAY_IDENTITY]: [MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.RELAY_ERROR]: [MESSAGE_SOURCES.RELAY],
  [MESSAGE_TYPES.AGENT_HELLO]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.AGENT_STATUS]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.RADIO_SET]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.RADIO_STATE]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.STATIONS_STATE]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.CHAT_SEND]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.CHAT_MESSAGE]: [MESSAGE_SOURCES.AGENT],
  [MESSAGE_TYPES.WEATHER_REQUEST]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.ATIS_REQUEST]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.XPDR_SET_SQUAWK]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.XPDR_SET_MODE]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.XPDR_IDENT]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.TX_START]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.TX_STOP]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.MONITOR_START]: [MESSAGE_SOURCES.BROWSER],
  [MESSAGE_TYPES.MONITOR_STOP]: [MESSAGE_SOURCES.BROWSER],
});

function createRemoteMessage(type, payload = {}, id = '') {
  return {
    v: REMOTE_PROTOCOL_VERSION,
    id: id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    payload,
  };
}

function parseRemoteJson(text, options = {}) {
  if (Buffer.byteLength(String(text), 'utf8') > MAX_JSON_MESSAGE_BYTES) {
    return fail('message too large');
  }

  try {
    return validateRemoteMessage(JSON.parse(text), options);
  } catch (_) {
    return fail('invalid json');
  }
}

function validateRemoteMessage(message, options = {}) {
  if (!isPlainObject(message)) return fail('message must be an object');
  if (message.v !== REMOTE_PROTOCOL_VERSION) return fail('unsupported protocol version');
  if (!isId(message.id)) return fail('invalid message id');
  if (!isKnownType(message.type)) return fail('unknown message type');

  const allowedSources = SOURCE_RULES[message.type] || [];
  if (options.source && !allowedSources.includes(options.source)) {
    return fail(`message type ${message.type} is not allowed from ${options.source}`);
  }

  const payload = message.payload === undefined ? {} : message.payload;
  if (!isPlainObject(payload)) return fail('payload must be an object');

  const payloadResult = validatePayload(message.type, payload);
  if (!payloadResult.ok) return payloadResult;

  return {
    ok: true,
    message: {
      v: REMOTE_PROTOCOL_VERSION,
      id: message.id,
      type: message.type,
      payload: payloadResult.payload,
    },
  };
}

function validatePayload(type, payload) {
  switch (type) {
    case MESSAGE_TYPES.PING:
    case MESSAGE_TYPES.PONG:
    case MESSAGE_TYPES.DEVICE_LIST:
    case MESSAGE_TYPES.XPDR_IDENT:
    case MESSAGE_TYPES.TX_STOP:
    case MESSAGE_TYPES.MONITOR_STOP:
      return noExtraPayload(payload);

    case MESSAGE_TYPES.DEVICE_SELECT:
      return requireShape(payload, { deviceId: isTokenLike });

    case MESSAGE_TYPES.DEVICE_STATE:
      return requireShape(payload, {
        deviceId: isTokenLike,
        deviceName: isShortText,
        online: isBoolean,
      });

    case MESSAGE_TYPES.PAIRING_BEGIN:
      return requireShape(payload, { deviceName: isShortText });

    case MESSAGE_TYPES.PAIRING_CODE:
      return requireShape(payload, { code: isPairingCode, expiresAt: isIsoLike });

    case MESSAGE_TYPES.PAIRING_CONFIRM:
      return requireShape(payload, { code: isPairingCode });

    case MESSAGE_TYPES.PAIRING_REVOKE:
    case MESSAGE_TYPES.PAIRING_REVOKED:
      return requireShape(payload, { deviceId: isTokenLike });

    case MESSAGE_TYPES.RELAY_IDENTITY:
      return requireShape(payload, { userId: isUserId }, { userName: isShortText });

    case MESSAGE_TYPES.RELAY_ERROR:
      return requireShape(payload, { code: isShortText, message: isText });

    case MESSAGE_TYPES.AGENT_HELLO:
      return requireShape(payload, { deviceName: isShortText }, { deviceId: isTokenLike });

    case MESSAGE_TYPES.AGENT_STATUS:
      return requireShape(payload, {
        connected: isBoolean,
      }, {
        callsign: isCallsign,
        flightPlanStatus: isFlightPlanStatus,
        webTxEnabled: isBoolean,
        txReady: isBoolean,
        txSampleRate: isSampleRate,
        squawk: isSquawk,
        xpdrMode: isXpdrMode,
      });

    case MESSAGE_TYPES.RADIO_SET:
      return requireShape(payload, {
        com: isCom,
        freq: isFrequency,
      }, {
        station: isStationName,
      });

    case MESSAGE_TYPES.RADIO_STATE:
      return requireShape(payload, {
        com1: isFrequency,
        com2: isFrequency,
      }, {
        station1: isStationName,
        station2: isStationName,
      });

    case MESSAGE_TYPES.STATIONS_STATE:
      return validateStationsState(payload);

    case MESSAGE_TYPES.CHAT_SEND:
      return requireShape(payload, { recipient: isRecipient, text: isText });

    case MESSAGE_TYPES.CHAT_MESSAGE:
      return requireShape(payload, {
        sender: isShortText,
        recipient: isShortText,
        text: isText,
        timestamp: isIsoLike,
      }, {
        direction: isDirection,
      });

    case MESSAGE_TYPES.WEATHER_REQUEST:
      return requireShape(payload, { kind: isWeatherKind, icao: isIcao });

    case MESSAGE_TYPES.ATIS_REQUEST:
      return requireShape(payload, { callsign: isStationName });

    case MESSAGE_TYPES.XPDR_SET_SQUAWK:
      return requireShape(payload, { code: isSquawk });

    case MESSAGE_TYPES.XPDR_SET_MODE:
      return requireShape(payload, { mode: isXpdrMode });

    case MESSAGE_TYPES.TX_START:
    case MESSAGE_TYPES.MONITOR_START:
      return requireShape(payload, { com: isCom });

    default:
      return fail('payload validator missing');
  }
}

function noExtraPayload(payload) {
  return Object.keys(payload).length === 0 ? ok({}) : fail('payload must be empty');
}

function requireShape(payload, required, optional = {}) {
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return fail(`unexpected payload field: ${key}`);
  }

  const normalized = {};
  for (const [key, validator] of Object.entries(required)) {
    if (!(key in payload)) return fail(`missing payload field: ${key}`);
    if (!validator(payload[key])) return fail(`invalid payload field: ${key}`);
    normalized[key] = payload[key];
  }

  for (const [key, validator] of Object.entries(optional)) {
    if (!(key in payload)) continue;
    if (!validator(payload[key])) return fail(`invalid payload field: ${key}`);
    normalized[key] = payload[key];
  }

  return ok(normalized);
}

function validateStationsState(payload) {
  if (!isPlainObject(payload)) return fail('payload must be an object');
  const allowed = new Set(['stations', 'ownPosition']);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return fail(`unexpected payload field: ${key}`);
  }

  if (!Array.isArray(payload.stations) || payload.stations.length > 250) {
    return fail('invalid payload field: stations');
  }

  const stations = [];
  for (const station of payload.stations) {
    const normalized = normalizeStationSnapshot(station);
    if (!normalized) return fail('invalid station snapshot');
    stations.push(normalized);
  }

  const normalized = { stations };
  if ('ownPosition' in payload) {
    if (!isOwnPosition(payload.ownPosition)) return fail('invalid payload field: ownPosition');
    normalized.ownPosition = {
      lat: payload.ownPosition.lat,
      lon: payload.ownPosition.lon,
    };
  }

  return ok(normalized);
}

function normalizeStationSnapshot(station) {
  if (!isPlainObject(station)) return null;
  const allowed = new Set(['callsign', 'freq', 'lat', 'lon', 'voice']);
  for (const key of Object.keys(station)) {
    if (!allowed.has(key)) return null;
  }
  if (!isStationName(station.callsign) || !station.callsign) return null;
  if (station.freq !== undefined && station.freq !== '' && !isFrequency(station.freq)) return null;
  if (station.lat !== undefined && !isCoordinate(station.lat, -90, 90)) return null;
  if (station.lon !== undefined && !isCoordinate(station.lon, -180, 180)) return null;
  if (station.voice !== undefined && station.voice !== '' && !isShortishText(station.voice, 256)) return null;

  const normalized = {
    callsign: station.callsign,
    freq: station.freq || '',
  };
  if (station.lat !== undefined) normalized.lat = station.lat;
  if (station.lon !== undefined) normalized.lon = station.lon;
  if (station.voice !== undefined) normalized.voice = station.voice || '';
  return normalized;
}

function isKnownType(type) {
  return Object.values(MESSAGE_TYPES).includes(type);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(value);
}

function isTokenLike(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(value);
}

function isUserId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{2,48}$/.test(value);
}

function isPairingCode(value) {
  return typeof value === 'string' && /^[A-Z0-9-]{6,32}$/.test(value);
}

function isShortText(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128;
}

function isText(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function isShortishText(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isSampleRate(value) {
  return Number.isInteger(value) && value >= 8000 && value <= 48000;
}

function isCom(value) {
  return value === 1 || value === 2;
}

function isFrequency(value) {
  if (typeof value !== 'string' || !/^1[0-9]{2}\.[0-9]{3}$/.test(value)) return false;
  const mhz = Number(value);
  return Number.isFinite(mhz) && mhz >= 118 && mhz <= 136.975;
}

function isStationName(value) {
  return value === '' || (typeof value === 'string' && /^[A-Z0-9_ -]{1,32}$/.test(value));
}

function isRecipient(value) {
  return typeof value === 'string' && /^(\*|@[0-9]{5}|[A-Z0-9_]{2,16})$/.test(value);
}

function isCallsign(value) {
  return typeof value === 'string' && /^[A-Z0-9]{2,16}$/.test(value);
}

function isFlightPlanStatus(value) {
  return value === 'filed' || value === 'missing';
}

function isWeatherKind(value) {
  return value === 'metar' || value === 'taf';
}

function isIcao(value) {
  return typeof value === 'string' && /^[A-Z]{4}$/.test(value);
}

function isCoordinate(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isOwnPosition(value) {
  return isPlainObject(value) && isCoordinate(value.lat, -90, 90) && isCoordinate(value.lon, -180, 180);
}

function isDirection(value) {
  return value === 'incoming' || value === 'outgoing';
}

function isSquawk(value) {
  return typeof value === 'string' && /^[0-7]{4}$/.test(value);
}

function isXpdrMode(value) {
  return value === 'stby' || value === 'alt';
}

function isIsoLike(value) {
  return typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(value);
}

function ok(payload) {
  return { ok: true, payload };
}

function fail(error) {
  return { ok: false, error };
}

module.exports = {
  REMOTE_PROTOCOL_VERSION,
  MAX_JSON_MESSAGE_BYTES,
  MAX_TEXT_BYTES,
  MESSAGE_SOURCES,
  MESSAGE_TYPES,
  createRemoteMessage,
  parseRemoteJson,
  validateRemoteMessage,
};
