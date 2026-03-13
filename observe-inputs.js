#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const BUTTON_KEYS = ['up', 'down', 'left', 'right', 'A', 'B'];
const EMPTY_STATE = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  A: false,
  B: false
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
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

    parsed[key] = value;
  }

  return parsed;
}

function normalizeState(input = {}) {
  return {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    A: Boolean(input.A),
    B: Boolean(input.B)
  };
}

function toObserveUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.pathname = '/observe';
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  if (token) {
    url.searchParams.set('token', token);
  }

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

const env = loadDotEnv(path.join(__dirname, '.env'));
const baseUrl = process.argv[2] || process.env.PAD_URL || env.PHONEPAD_PUBLIC_URL;
const token = process.argv[3] || process.env.PAD_TOKEN || env.PHONEPAD_ACCESS_TOKEN;

if (!baseUrl) {
  console.error('Usage: node observe-inputs.js <base_url> [admin_token]');
  console.error('Or set PAD_URL/PAD_TOKEN or PHONEPAD_PUBLIC_URL/PHONEPAD_ACCESS_TOKEN in .env');
  process.exit(1);
}

let observeUrl;
try {
  observeUrl = toObserveUrl(baseUrl, token);
} catch {
  console.error(`Invalid URL: ${baseUrl}`);
  process.exit(1);
}

const lastStateByPlayer = new Map();
const ws = new WebSocket(observeUrl);

ws.on('open', () => {
  console.log(`listening on ${redactTokenInUrl(observeUrl)}`);
});

ws.on('message', (payload) => {
  let message;
  try {
    message = JSON.parse(payload.toString());
  } catch {
    return;
  }

  if (message.type === 'snapshot' && typeof message.players === 'object' && message.players !== null) {
    for (const [playerId, playerState] of Object.entries(message.players)) {
      lastStateByPlayer.set(playerId, normalizeState(playerState));
    }
    return;
  }

  if (message.type !== 'input' || typeof message.playerId !== 'string') {
    return;
  }

  const nextState = normalizeState(message.state);
  const previousState = lastStateByPlayer.get(message.playerId) ?? EMPTY_STATE;
  const timestamp = new Date(message.timestamp ?? Date.now()).toISOString();

  for (const key of BUTTON_KEYS) {
    if (previousState[key] === nextState[key]) {
      continue;
    }

    console.log(
      `${timestamp} player=${message.playerId} button=${key} event=${nextState[key] ? 'down' : 'up'}`
    );
  }

  lastStateByPlayer.set(message.playerId, nextState);
});

ws.on('close', () => {
  console.error('observer disconnected');
  process.exit(1);
});

ws.on('error', (error) => {
  console.error(`observer error: ${error.message}`);
});
