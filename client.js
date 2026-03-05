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

function writeToBridge(bridgeProcess, message) {
  if (bridgeProcess.killed || !bridgeProcess.stdin.writable) {
    return;
  }

  bridgeProcess.stdin.write(`${JSON.stringify(message)}\n`);
}

const fileEnv = loadDotEnv(dotenvPath);
const baseUrl = process.argv[2] || process.env.PAD_URL || fileEnv.PHONEPAD_PUBLIC_URL || '';
const token = process.argv[3] || process.env.PAD_TOKEN || fileEnv.PHONEPAD_ACCESS_TOKEN || '';
let socket;
let reconnectTimer = null;
let shuttingDown = false;

if (!baseUrl || !token) {
  console.error('Usage: node client.js <base_url> <token>');
  console.error('Or set PAD_URL/PAD_TOKEN or PHONEPAD_PUBLIC_URL/PHONEPAD_ACCESS_TOKEN in .env');
  process.exit(1);
}

let observeUrl;
try {
  observeUrl = buildObserveUrl(baseUrl, token);
} catch {
  console.error(`Invalid base URL: ${baseUrl}`);
  process.exit(1);
}

const bridge = spawn('python3', [path.join(__dirname, 'virtual-gamepad.py')], {
  stdio: ['pipe', 'inherit', 'inherit']
});

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

function connectObserver() {
  clearReconnectTimer();
  socket = new WebSocket(observeUrl);

  socket.on('open', () => {
    console.log(`client connected to ${observeUrl}`);
  });

  socket.on('message', (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      return;
    }

    if (message.type === 'snapshot' && typeof message.players === 'object' && message.players !== null) {
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
      writeToBridge(bridge, { type: 'reset_player', playerId: message.playerId });
    }
  });

  socket.on('close', () => {
    if (!shuttingDown) {
      console.error('observer disconnected, retrying...');
      scheduleReconnect();
    }
  });

  socket.on('error', (error) => {
    console.error(`observer error: ${error.message}`);
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
