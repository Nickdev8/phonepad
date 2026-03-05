const statusElement = document.getElementById('status');
const reconnectButton = document.getElementById('reconnect-now');
const dpadElement = document.getElementById('dpad');
const actionsElement = document.getElementById('actions');
const extrasElement = document.getElementById('extras');

const DEVICE_STORAGE_KEY = 'phonepad_device_id';
const RETRY_SECONDS = 3;
const AUTH_CHECK_TIMEOUT_MS = 3000;
const SEND_INTERVAL_MS = 1000 / 60;
const DEFAULT_INPUTS = Object.freeze(['up', 'down', 'left', 'right', 'A', 'B']);
const DPAD_LABELS = Object.freeze({
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
});

const token = new URLSearchParams(window.location.search).get('token') ?? '';
const deviceId = getOrCreateDeviceId();

let inputKeys = [...DEFAULT_INPUTS];
let state = createState(inputKeys);
let socket = null;
let retryTimer = null;
let retryCountdownTimer = null;
let retrySecondsRemaining = 0;
let connectAttemptInFlight = false;
let controlsReady = false;

function createDeviceId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `phonepad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const created = createDeviceId();
    localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    return createDeviceId();
  }
}

function sanitizeInputKeys(rawKeys) {
  if (!Array.isArray(rawKeys)) {
    return [...DEFAULT_INPUTS];
  }

  const sanitized = [];
  const seen = new Set();
  for (const rawKey of rawKeys) {
    const key = String(rawKey ?? '').trim();
    if (!key || key.length > 24) {
      continue;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sanitized.push(key);
  }

  return sanitized.length > 0 ? sanitized : [...DEFAULT_INPUTS];
}

function createState(keys) {
  const nextState = {};
  for (const key of keys) {
    nextState[key] = false;
  }

  return nextState;
}

function isDpadKey(key) {
  const normalized = key.toLowerCase();
  return normalized === 'up' || normalized === 'down' || normalized === 'left' || normalized === 'right';
}

function getDpadSlot(key) {
  return key.toLowerCase();
}

function getControlLabel(key) {
  const normalized = key.toLowerCase();
  if (DPAD_LABELS[normalized]) {
    return DPAD_LABELS[normalized];
  }

  return key.length <= 4 ? key.toUpperCase() : key;
}

function setStatus(text, type) {
  statusElement.textContent = text;
  statusElement.className = `status ${type}`;
}

function setReconnectVisible(visible) {
  reconnectButton.hidden = !visible;
}

function clearRetryTimers() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  if (retryCountdownTimer) {
    clearInterval(retryCountdownTimer);
    retryCountdownTimer = null;
  }
}

function buildConfigUrl() {
  const url = new URL('/config', window.location.origin);
  if (token) {
    url.searchParams.set('token', token);
  }

  return url.toString();
}

function buildStateUrl() {
  const url = new URL('/state', window.location.origin);
  if (token) {
    url.searchParams.set('token', token);
  }

  return url.toString();
}

function buildWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = new URL(`${protocol}://${window.location.host}/ws`);
  if (token) {
    wsUrl.searchParams.set('token', token);
  }
  wsUrl.searchParams.set('device', deviceId);
  return wsUrl.toString();
}

async function fetchWithTimeout(url) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), AUTH_CHECK_TIMEOUT_MS);

  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: abortController.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadControllerConfig() {
  try {
    const response = await fetchWithTimeout(buildConfigUrl());
    if (response.status === 401) {
      return { ok: false, invalidUrl: true, inputs: [] };
    }

    if (!response.ok) {
      return { ok: false, invalidUrl: false, inputs: [] };
    }

    const payload = await response.json();
    return {
      ok: true,
      invalidUrl: false,
      inputs: sanitizeInputKeys(payload.inputs)
    };
  } catch {
    return { ok: false, invalidUrl: false, inputs: [] };
  }
}

async function checkControllerUrl() {
  try {
    const response = await fetchWithTimeout(buildStateUrl());
    if (response.status === 401) {
      return { ok: false, invalidUrl: true };
    }

    return { ok: response.ok, invalidUrl: false };
  } catch {
    return { ok: false, invalidUrl: false };
  }
}

function scheduleRetry(reason, nextStep) {
  clearRetryTimers();
  retrySecondsRemaining = RETRY_SECONDS;
  setReconnectVisible(true);
  setStatus(`${reason}. retrying in ${retrySecondsRemaining}s`, 'retrying');

  retryCountdownTimer = setInterval(() => {
    retrySecondsRemaining -= 1;
    if (retrySecondsRemaining > 0) {
      setStatus(`${reason}. retrying in ${retrySecondsRemaining}s`, 'retrying');
    }
  }, 1000);

  retryTimer = setTimeout(() => {
    clearRetryTimers();
    nextStep();
  }, RETRY_SECONDS * 1000);
}

function sendState() {
  if (!controlsReady || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'input',
      state
    })
  );
}

function setButtonState(button, key, pressed) {
  if (state[key] === pressed) {
    return;
  }

  state[key] = pressed;
  button.classList.toggle('active', pressed);
  sendState();
}

function bindButton(button, key) {
  const press = (event) => {
    event.preventDefault();
    if (event.pointerId !== undefined) {
      button.setPointerCapture(event.pointerId);
    }

    setButtonState(button, key, true);
  };

  const release = (event) => {
    event.preventDefault();
    setButtonState(button, key, false);
  };

  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', (event) => {
    if (event.buttons === 0) {
      release(event);
    }
  });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

function createControlButton(key) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'control-btn';
  button.dataset.key = key;
  button.textContent = getControlLabel(key);

  if (isDpadKey(key)) {
    button.classList.add('dpad-btn');
    button.dataset.slot = getDpadSlot(key);
  } else {
    button.classList.add('action-btn');
  }

  bindButton(button, key);
  return button;
}

function renderControls(keys) {
  dpadElement.innerHTML = '';
  actionsElement.innerHTML = '';
  extrasElement.innerHTML = '';

  const actionKeys = [];
  const extraKeys = [];
  for (const key of keys) {
    if (isDpadKey(key)) {
      dpadElement.appendChild(createControlButton(key));
      continue;
    }

    if (actionKeys.length < 8) {
      actionKeys.push(key);
    } else {
      extraKeys.push(key);
    }
  }

  for (const key of actionKeys) {
    actionsElement.appendChild(createControlButton(key));
  }

  for (const key of extraKeys) {
    extrasElement.appendChild(createControlButton(key));
  }

  extrasElement.hidden = extraKeys.length === 0;
  dpadElement.hidden = dpadElement.children.length === 0;
  actionsElement.hidden = actionsElement.children.length === 0;
}

async function connectWebSocket() {
  if (!controlsReady || connectAttemptInFlight) {
    return;
  }

  connectAttemptInFlight = true;
  clearRetryTimers();
  setReconnectVisible(false);
  setStatus('checking controller URL...', 'connecting');

  const check = await checkControllerUrl();
  if (check.invalidUrl) {
    setStatus('invalid controller URL (missing or wrong token)', 'error');
    connectAttemptInFlight = false;
    return;
  }

  if (!check.ok) {
    connectAttemptInFlight = false;
    scheduleRetry('failed to reach server', connectWebSocket);
    return;
  }

  setStatus('trying to connect...', 'connecting');
  const activeSocket = new WebSocket(buildWsUrl());
  socket = activeSocket;
  let opened = false;
  connectAttemptInFlight = false;

  activeSocket.addEventListener('open', () => {
    if (socket !== activeSocket) {
      return;
    }

    opened = true;
    clearRetryTimers();
    setReconnectVisible(false);
    setStatus('connected', 'connected');
  });

  activeSocket.addEventListener('close', async () => {
    if (socket !== activeSocket) {
      return;
    }

    socket = null;
    if (opened) {
      scheduleRetry('disconnected', connectWebSocket);
      return;
    }

    const postCloseCheck = await checkControllerUrl();
    if (socket !== null) {
      return;
    }

    if (postCloseCheck.invalidUrl) {
      setReconnectVisible(false);
      setStatus('invalid controller URL (missing or wrong token)', 'error');
      return;
    }

    scheduleRetry('failed to connect', connectWebSocket);
  });

  activeSocket.addEventListener('error', () => {
    if (socket !== activeSocket) {
      return;
    }

    if (!opened) {
      setStatus('connection failed', 'disconnected');
    }
  });
}

async function initController() {
  setStatus('loading controller...', 'connecting');
  setReconnectVisible(false);

  const config = await loadControllerConfig();
  if (config.invalidUrl) {
    setStatus('invalid controller URL (missing or wrong token)', 'error');
    return;
  }

  if (!config.ok) {
    scheduleRetry('failed to load controller config', initController);
    return;
  }

  inputKeys = config.inputs;
  state = createState(inputKeys);
  renderControls(inputKeys);
  controlsReady = true;
  connectWebSocket();
}

reconnectButton.addEventListener('click', () => {
  clearRetryTimers();
  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
});

setInterval(sendState, SEND_INTERVAL_MS);
initController();
