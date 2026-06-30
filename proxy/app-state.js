'use strict';

const { normalizeSquawkCode } = require('./fsd-parser');
const { formatComFrequency } = require('./pilot-core');

function createAppState(options) {
  // This object is the local source of truth for UI-visible simulator state.
  // Network modules update it through small methods, and it emits typed events
  // to the local webapp plus the remote relay through the provided publisher.
  const timestamp = options.timestamp;
  const publish = options.publish;

  const messageLog = [];
  const currentComFrequencies = { 1: '', 2: '' };
  const currentComStations = { 1: '', 2: '' };
  const currentXpdrState = { squawk: '', mode: '' };
  const knownStations = new Map();

  let callsign = null;
  let connected = false;
  let flightPlanStatus = 'missing';
  let ownPosition = null;

  function broadcast(data) {
    // Recording chat history here keeps reconnect snapshots consistent no
    // matter whether a message came from FSD, local UI, or remote control.
    if (data.kind === 'message') {
      messageLog.push(data);
      if (messageLog.length > 200) messageLog.shift();
    }
    publish(data);
  }

  function setConnected(value, notify = true) {
    // Connection events may repeat during reconnect races. Re-broadcasting is
    // intentional: it lets stale browser status recover from old socket closes.
    connected = Boolean(value);
    if (notify) broadcast({ kind: 'status', connected, callsign });
  }

  function setCallsign(value, notify = true) {
    // Callsigns are learned from PilotUI and FSD. The validator keeps accidental
    // protocol fragments out of the user-visible state.
    const next = String(value || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,10}$/.test(next) || next === callsign) return false;
    callsign = next;
    if (notify) broadcast({ kind: 'login', callsign, own: true, timestamp: timestamp() });
    return true;
  }

  function updateComFrequency(com, freq, station = '') {
    // Store the latest known COM state. New browser tabs receive this snapshot
    // in their init message, while existing tabs receive the live event.
    const radio = com === 2 ? 2 : 1;
    const value = formatComFrequency(freq);
    if (!value) return false;
    const selectedStation = stationForFrequency(value, station || currentComStations[radio]);
    if (currentComFrequencies[radio] === value && currentComStations[radio] === selectedStation) return false;
    currentComFrequencies[radio] = value;
    currentComStations[radio] = selectedStation;
    broadcast({ kind: 'freq_update', com: radio, freq: value, station: selectedStation });
    return true;
  }

  function stationForFrequency(freq, preferred = '') {
    const value = formatComFrequency(freq);
    const preferredStation = knownStations.get(String(preferred || '').toUpperCase());
    if (preferredStation && formatComFrequency(preferredStation.freq) === value) return preferredStation.callsign;
    if (value === '122.800') return 'UNICOM';

    for (const station of knownStations.values()) {
      if (formatComFrequency(station.freq) === value) return station.callsign;
    }
    return '';
  }

  function updateXpdrState(data, notify = true) {
    // Own FSD position packets carry the transponder state PilotCore is actually
    // sending to IVAO. Store it so browser tabs stay in sync with external
    // transponder changes.
    let changed = false;
    const squawk = normalizeSquawkCode(data.squawk);
    if (squawk && currentXpdrState.squawk !== squawk) {
      currentXpdrState.squawk = squawk;
      changed = true;
    }

    const mode = data.mode || data.xpdrMode;
    if ((mode === 'stby' || mode === 'alt') && currentXpdrState.mode !== mode) {
      currentXpdrState.mode = mode;
      changed = true;
    }

    if (changed && notify) {
      broadcast({
        kind: 'xpdr_update',
        squawk: currentXpdrState.squawk,
        mode: currentXpdrState.mode,
        timestamp: timestamp(),
      });
    }
    return changed;
  }

  function updateFlightPlanStatus(status, notify = true) {
    // FSD flight plan errors can repeat often. Keep them as compact UI state
    // instead of filling the chat with identical SERVER messages.
    if (status !== 'filed' && status !== 'missing') return false;
    if (flightPlanStatus === status) return false;
    flightPlanStatus = status;
    if (notify) {
      broadcast({
        kind: 'flight_plan_status',
        status: flightPlanStatus,
        timestamp: timestamp(),
      });
    }
    return true;
  }

  function rememberStation(data) {
    const stationCallsign = String(data.callsign || data.atc || '').toUpperCase();
    if (!stationCallsign || stationCallsign.endsWith('_OBS')) return;
    if (!stationCallsign.includes('_') && stationCallsign !== 'UNICOM') return;

    const current = knownStations.get(stationCallsign) || { callsign: stationCallsign };
    const next = {
      ...current,
      callsign: stationCallsign,
      freq: data.freq || current.freq || '',
      lat: Number.isFinite(Number(data.lat)) ? Number(data.lat) : current.lat,
      lon: Number.isFinite(Number(data.lon)) ? Number(data.lon) : current.lon,
      voice: data.ts2Server || data.server
        ? `${data.ts2Server || data.server}/${data.channelName || data.channel || stationCallsign}`
        : current.voice || '',
    };
    knownStations.set(stationCallsign, next);
  }

  function rememberFsdState(msg) {
    if (msg.kind === 'own_position') {
      ownPosition = { lat: msg.lat, lon: msg.lon };
      updateXpdrState(msg);
      return;
    }

    if (msg.kind === 'atc_detected') rememberStation(msg);
    if (msg.kind === 'atc_voice_info') {
      rememberStation({
        callsign: msg.atc,
        ts2Server: msg.ts2Server,
        channelName: msg.channelName,
      });
    }
  }

  function getStatus() {
    return {
      connected,
      callsign,
      flightPlanStatus,
      squawk: currentXpdrState.squawk,
      xpdrMode: currentXpdrState.mode,
    };
  }

  function getRadioState() {
    return {
      com1: currentComFrequencies[1],
      com2: currentComFrequencies[2],
      station1: currentComStations[1],
      station2: currentComStations[2],
    };
  }

  function getStationsState() {
    return {
      stations: Array.from(knownStations.values()),
      ownPosition,
    };
  }

  function getInitState() {
    return {
      connected,
      callsign,
      comFrequencies: { ...currentComFrequencies },
      comStations: { ...currentComStations },
      xpdrState: { ...currentXpdrState },
      flightPlanStatus,
      stations: Array.from(knownStations.values()),
      ownPosition,
      log: messageLog.slice(-100),
    };
  }

  return {
    broadcast,
    getCallsign: () => callsign,
    getConnected: () => connected,
    getFlightPlanStatus: () => flightPlanStatus,
    getStatus,
    getRadioState,
    getStationsState,
    getInitState,
    setConnected,
    setCallsign,
    updateComFrequency,
    updateXpdrState,
    updateFlightPlanStatus,
    rememberFsdState,
    rememberStation,
  };
}

module.exports = {
  createAppState,
};
