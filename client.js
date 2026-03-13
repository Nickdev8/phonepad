#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dotenvPath = path.join(__dirname, '.env');
const DEBUG_ENABLED = parseDebugFlag(
  process.env.PAD_DEBUG || process.env.PHONEPAD_DEBUG || ''
);
let notifySendFailed = false;

function loadDotEnv(filePath) {
  const loaded = {};
  if (!fs.existsSync(filePath)) {
    return loaded;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    loaded[key] = value;
  }

  return loaded;
}

function parseDebugFlag(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value) {
    return false;
  }

  return !(value === '0' || value === 'off' || value === 'false' || value === 'no');
}

function buildObserveUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/observe';
  url.search = '';
  if (token) {
    url.searchParams.set('token', token);
  }

  return url.toString();
}

function buildLayoutUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'https:' : 'http:';
  url.pathname = '/layout';
  url.search = '';
  return url.toString();
}

function redactTokenInUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', 'REDACTED');
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function writeToBridge(bridgeProcess, message) {
  debugBridgeMessage(message);
  if (bridgeProcess.killed || !bridgeProcess.stdin.writable) {
    return;
  }

  bridgeProcess.stdin.write(`${JSON.stringify(message)}\n`);
}

function debugLog(message) {
  if (!DEBUG_ENABLED) {
    return;
  }

  console.error(`[debug] ${message}`);
}

function sendDebugNotification(title, body) {
  if (!DEBUG_ENABLED || notifySendFailed) {
    return;
  }

  const child = spawn('notify-send', ['-a', 'PhonePad', title, body], {
    stdio: 'ignore'
  });

  child.on('error', () => {
    notifySendFailed = true;
    debugLog('notify-send is unavailable; desktop notifications disabled');
  });
}

const lastDebugStateSummaryByPlayer = new Map();

function summarizeState(state) {
  if (!state || typeof state !== 'object') {
    return 'invalid';
  }

  const activeInputs = [];
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'number') {
      if (value !== 0) {
        activeInputs.push(`${key}=${value}`);
      }
      continue;
    }

    if (value) {
      activeInputs.push(key);
    }
  }

  return activeInputs.length > 0 ? activeInputs.join(',') : 'idle';
}

function debugBridgeMessage(message) {
  if (!DEBUG_ENABLED || !message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'state') {
    const playerId = typeof message.playerId === 'string' ? message.playerId : 'unknown';
    const nextSummary = summarizeState(message.state);
    const previousSummary = lastDebugStateSummaryByPlayer.get(playerId);
    if (previousSummary === nextSummary) {
      return;
    }

    lastDebugStateSummaryByPlayer.set(playerId, nextSummary);
    debugLog(`bridge state player=${playerId} ${nextSummary}`);
    sendDebugNotification('PhonePad input', `player=${playerId} ${nextSummary}`);
    return;
  }

  if (message.type === 'sync_players' && Array.isArray(message.playerIds)) {
    debugLog(`bridge sync players=${message.playerIds.join(',') || '(none)'}`);
    return;
  }

  if ((message.type === 'reset_player' || message.type === 'remove_player') && typeof message.playerId === 'string') {
    debugLog(`bridge ${message.type} player=${message.playerId}`);
    lastDebugStateSummaryByPlayer.delete(message.playerId);
  }
}

const fileEnv = loadDotEnv(dotenvPath);
const baseUrl = process.argv[2] || process.env.PAD_URL || fileEnv.PHONEPAD_PUBLIC_URL || '';
const token = process.argv[3] || process.env.PAD_TOKEN || fileEnv.PHONEPAD_ACCESS_TOKEN || '';
const layoutPayloadRaw = process.env.PAD_LAYOUT_JSON || '';
let layoutPayload = null;
if (layoutPayloadRaw) {
  try {
    const parsed = JSON.parse(layoutPayloadRaw);
    if (parsed && typeof parsed === 'object') {
      layoutPayload = parsed;
    }
  } catch {
    layoutPayload = null;
  }
}
let socket;
let reconnectTimer = null;
let shuttingDown = false;
let publishedLayout = false;
let layoutUrl = '';

if (!baseUrl) {
  console.error('Usage: node client.js <base_url> [admin_token]');
  console.error('Or set PAD_URL/PAD_TOKEN or PHONEPAD_PUBLIC_URL/PHONEPAD_ACCESS_TOKEN in .env');
  process.exit(1);
}

let observeUrl;
try {
  observeUrl = buildObserveUrl(baseUrl, token);
  layoutUrl = buildLayoutUrl(baseUrl);
} catch {
  console.error(`Invalid base URL: ${baseUrl}`);
  process.exit(1);
}

const bridge = spawn('python3', [path.join(__dirname, 'virtual-gamepad.py')], {
  stdio: ['pipe', 'inherit', 'inherit']
});
debugLog(`spawned virtual bridge pid=${bridge.pid ?? 'unknown'}`);

bridge.on('exit', (code, signal) => {
  if (shuttingDown) {
    process.exit(code ?? 0);
    return;
  }

  if (signal) {
    console.error(`virtual gamepad bridge exited via signal ${signal}`);
  } else {
    console.error(`virtual gamepad bridge exited with code ${code ?? 0}`);
  }
  process.exit(code ?? 1);
});

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectObserver();
  }, 1000);
}

async function publishLayout() {
  if (!layoutPayload || !layoutUrl || shuttingDown) {
    return;
  }

  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(layoutUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(layoutPayload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!publishedLayout) {
      console.log('layout synced');
    }
    publishedLayout = true;
  } catch (error) {
    if (publishedLayout) {
      publishedLayout = false;
    }

    console.error(`layout sync failed: ${error.message}`);
    debugLog(`layout publish failed against ${layoutUrl}: ${error.message}`);
  }
}

function connectObserver() {
  clearReconnectTimer();
  debugLog(`connecting observer ${observeUrl}`);
  socket = new WebSocket(observeUrl);

  socket.on('open', () => {
    console.log(`client connected to ${redactTokenInUrl(observeUrl)}`);
    debugLog('observer websocket open');
    publishLayout();
  });

  socket.on('message', (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return;
    }

    if (message.type === 'snapshot' && typeof message.players === 'object' && message.players !== null) {
      debugLog(`observer snapshot players=${Object.keys(message.players).join(',') || '(none)'}`);
      writeToBridge(bridge, { type: 'sync_players', playerIds: Object.keys(message.players) });
      for (const [playerId, state] of Object.entries(message.players)) {
        writeToBridge(bridge, { type: 'state', playerId, state });
      }
      return;
    }

    if (message.type === 'input' && typeof message.playerId === 'string') {
      writeToBridge(bridge, { type: 'state', playerId: message.playerId, state: message.state ?? {} });
      return;
    }

    if (message.type === 'player_disconnected' && typeof message.playerId === 'string') {
      debugLog(`observer player_disconnected player=${message.playerId}`);
      writeToBridge(bridge, { type: 'reset_player', playerId: message.playerId });
      return;
    }

    if (message.type === 'player_removed' && typeof message.playerId === 'string') {
      debugLog(`observer player_removed player=${message.playerId}`);
      writeToBridge(bridge, { type: 'remove_player', playerId: message.playerId });
    }
  });

  socket.on('close', () => {
    if (!shuttingDown) {
      console.error('observer disconnected, retrying...');
      debugLog('observer websocket closed');
      scheduleReconnect();
    }
  });

  socket.on('error', (error) => {
    console.error(`observer error: ${error.message}`);
    debugLog(`observer websocket error: ${error.message}`);
  });
}

function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearReconnectTimer();
  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.close();
  }

  if (!bridge.killed) {
    bridge.kill('SIGTERM');
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

connectObserver();
publishLayout();
