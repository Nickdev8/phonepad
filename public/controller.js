const statusElement = document.getElementById('status');
const layoutInfoElement = document.getElementById('layout-info');
const deviceNoteElement = document.getElementById('device-note');
const reconnectButton = document.getElementById('reconnect-now');
const fullscreenButton = document.getElementById('fullscreen-now');
const appElement = document.querySelector('.app');
const dpadElement = document.getElementById('dpad');
const actionsElement = document.getElementById('actions');
const extrasElement = document.getElementById('extras');

const DEVICE_STORAGE_KEY = 'phonepad_device_id';
const TOKEN_STORAGE_KEY = 'phonepad_access_token';
const AUTH_CHECK_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 1000 / 12;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 3000;
const RETRY_JITTER_MS = 150;
const RETRY_CHECK_AUTH_AFTER = 3;
const MAX_BUFFERED_BYTES = 128 * 1024;
const HAPTIC_MIN_INTERVAL_MS = 25;
const FEEDBACK_FLASH_MS = 90;
const DIRECTION_THRESHOLD = 0.35;
const STICK_DEADZONE = 0.08;
const STICK_RESPONSE_EXPONENT = 1.4;
const STICK_SMOOTHING = 0.35;
const STICK_AXIS_PRECISION = 1000;
const DEFAULT_INPUTS = Object.freeze(['up', 'down', 'left', 'right', 'A', 'B']);
const DIRECTION_KEYS = Object.freeze(['up', 'down', 'left', 'right']);
const DEFAULT_CONTROLLER_CONFIG = Object.freeze({
  preset: 'classic',
  joystickMode: 'dpad',
  buttons: ['A', 'B'],
  haptics: true
});
const DPAD_LABELS = Object.freeze({
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
});

const urlParams = new URLSearchParams(window.location.search);
const token = resolveAccessToken(urlParams);
const deviceId = getOrCreateDeviceId();
const isAppleMobile = detectAppleMobile();
const nativeVibrationSupported = typeof navigator.vibrate === 'function';

let inputKeys = [...DEFAULT_INPUTS];
let state = createState(inputKeys);
let controllerConfig = {
  preset: DEFAULT_CONTROLLER_CONFIG.preset,
  joystickMode: DEFAULT_CONTROLLER_CONFIG.joystickMode,
  buttons: [...DEFAULT_CONTROLLER_CONFIG.buttons],
  haptics: DEFAULT_CONTROLLER_CONFIG.haptics
};
let directionKeys = resolveDirectionKeys(inputKeys);
let socket = null;
let retryTimer = null;
let retryCountdownTimer = null;
let retrySecondsRemaining = 0;
let connectAttemptInFlight = false;
let controlsReady = false;
let retryAttempts = 0;
let attemptedAutoFullscreen = false;
let hapticsEnabled = true;
let lastHapticAt = 0;
let feedbackFlashTimer = 0;
let smoothCleanup = null;
let standaloneMode = detectStandaloneMode();

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

function resolveAccessToken(searchParams) {
  const fromQuery = (searchParams.get('token') ?? '').trim();

  try {
    if (fromQuery) {
      localStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
      return fromQuery;
    }

    return (localStorage.getItem(TOKEN_STORAGE_KEY) ?? '').trim();
  } catch {
    return fromQuery;
  }
}

function detectAppleMobile() {
  const userAgent = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  return /iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function detectStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function supportsNativeHaptics() {
  return nativeVibrationSupported;
}

function syncRuntimeEnvironment() {
  standaloneMode = detectStandaloneMode();
  appElement.classList.toggle('ios-browser', isAppleMobile && !standaloneMode);
  appElement.classList.toggle('ios-standalone', isAppleMobile && standaloneMode);
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

    if (!/^[A-Za-z0-9_-]+$/.test(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    sanitized.push(key);
  }

  return sanitized.length > 0 ? sanitized : [...DEFAULT_INPUTS];
}

function sanitizeJoystickMode(rawMode) {
  const mode = String(rawMode ?? '').trim().toLowerCase();
  if (mode === 'smooth' || mode === 'none') {
    return mode;
  }

  return 'dpad';
}

function sanitizeButtons(rawButtons, keys) {
  const allowed = new Set(keys);
  const sanitized = [];
  const seen = new Set();

  for (const candidate of Array.isArray(rawButtons) ? rawButtons : []) {
    const key = String(candidate ?? '').trim();
    if (!key || seen.has(key) || !allowed.has(key) || isDpadKey(key)) {
      continue;
    }

    seen.add(key);
    sanitized.push(key);
  }

  return sanitized;
}

function sanitizeControllerConfig(rawConfig, keys) {
  const payload = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const directions = resolveDirectionKeys(keys);
  const hasDirections = DIRECTION_KEYS.some((direction) => Boolean(directions[direction]));
  const sanitizedButtons = sanitizeButtons(payload.buttons, keys);
  const fallbackButtons = keys.filter((key) => !isDpadKey(key));

  return {
    preset: String(payload.preset ?? DEFAULT_CONTROLLER_CONFIG.preset).trim() || DEFAULT_CONTROLLER_CONFIG.preset,
    joystickMode: hasDirections ? sanitizeJoystickMode(payload.joystickMode) : 'none',
    buttons: sanitizedButtons.length > 0 ? sanitizedButtons : fallbackButtons,
    haptics: payload.haptics !== false
  };
}

function createState(keys) {
  const nextState = {};
  for (const key of keys) {
    nextState[key] = false;
  }

  return nextState;
}

function resolveDirectionKeys(keys) {
  const resolved = {
    up: '',
    down: '',
    left: '',
    right: ''
  };

  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (!resolved[normalized] && DIRECTION_KEYS.includes(normalized)) {
      resolved[normalized] = key;
    }
  }

  return resolved;
}

function isDpadKey(key) {
  return DIRECTION_KEYS.includes(key.toLowerCase());
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

function setLayoutInfo() {
  if (!layoutInfoElement) {
    return;
  }

  const joystickLabel =
    controllerConfig.joystickMode === 'smooth'
      ? 'smooth stick'
      : controllerConfig.joystickMode === 'none'
        ? 'no stick'
      : 'd-pad';

  const buttonCount = inputKeys.filter((key) => !isDpadKey(key)).length;
  const buttonText = `${buttonCount} button${buttonCount === 1 ? '' : 's'}`;
  const hapticLabel = !controllerConfig.haptics ? 'off' : supportsNativeHaptics() ? 'on' : 'visual only';
  layoutInfoElement.textContent = `${controllerConfig.preset} | ${joystickLabel} | ${buttonText} | haptics ${hapticLabel}`;
}

function setDeviceNote(text) {
  if (!deviceNoteElement) {
    return;
  }

  const normalized = String(text ?? '').trim();
  deviceNoteElement.hidden = normalized.length === 0;
  deviceNoteElement.textContent = normalized;
}

function updateDeviceNote() {
  syncRuntimeEnvironment();

  const notes = [];
  if (isAppleMobile && !standaloneMode) {
    notes.push('iPhone/iPad fullscreen works best from Home Screen. Use Share, then Add to Home Screen.');
  }

  if (controllerConfig.haptics && !supportsNativeHaptics()) {
    if (isAppleMobile) {
      notes.push('Safari does not expose web vibration here, so haptics fall back to visual feedback.');
    } else {
      notes.push('This browser does not expose vibration, so haptics fall back to visual feedback.');
    }
  }

  setDeviceNote(notes.join(' '));
}

function setReconnectVisible(visible) {
  reconnectButton.hidden = !visible;
}

function getFullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function getFullscreenRequester() {
  const element = document.documentElement;
  if (typeof element.requestFullscreen === 'function') {
    return async () => element.requestFullscreen({ navigationUI: 'hide' });
  }

  if (typeof element.webkitRequestFullscreen === 'function') {
    return async () => element.webkitRequestFullscreen();
  }

  return null;
}

function canRequestFullscreen() {
  return Boolean(getFullscreenRequester());
}

async function enterFullscreen() {
  syncRuntimeEnvironment();
  if (standaloneMode || getFullscreenElement()) {
    return;
  }

  const requestFullscreen = getFullscreenRequester();
  if (!requestFullscreen) {
    if (isAppleMobile) {
      updateDeviceNote();
    }
    return;
  }

  try {
    await requestFullscreen();
  } catch {
    if (isAppleMobile) {
      updateDeviceNote();
    }
  }
}

function updateFullscreenButton() {
  syncRuntimeEnvironment();

  if (standaloneMode) {
    fullscreenButton.hidden = true;
    return;
  }

  if (canRequestFullscreen()) {
    fullscreenButton.hidden = Boolean(getFullscreenElement());
    fullscreenButton.textContent = 'Fullscreen';
    return;
  }

  if (isAppleMobile) {
    fullscreenButton.hidden = false;
    fullscreenButton.textContent = 'Add to Home Screen';
    return;
  }

  fullscreenButton.hidden = true;
}

function flashFeedback(intensity = 'light') {
  document.body.dataset.feedback = intensity;
  clearTimeout(feedbackFlashTimer);
  feedbackFlashTimer = setTimeout(() => {
    delete document.body.dataset.feedback;
  }, FEEDBACK_FLASH_MS);
}

function triggerHaptic(intensity = 'light') {
  if (!hapticsEnabled) {
    return;
  }

  const now = performance.now();
  if (now - lastHapticAt < HAPTIC_MIN_INTERVAL_MS) {
    return;
  }

  lastHapticAt = now;

  if (supportsNativeHaptics()) {
    navigator.vibrate(intensity === 'strong' ? 15 : 8);
    return;
  }

  flashFeedback(intensity);
}

function syncViewportMetrics() {
  const viewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
  document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`);
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

function getRetryDelayMs() {
  const exponential = RETRY_BASE_MS * 2 ** Math.min(retryAttempts, 5);
  const bounded = Math.min(RETRY_MAX_MS, exponential);
  const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
  return bounded + jitter;
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
      return { ok: false, invalidUrl: true, inputs: [], config: null };
    }

    if (!response.ok) {
      return { ok: false, invalidUrl: false, inputs: [], config: null };
    }

    const payload = await response.json();
    const nextInputs = sanitizeInputKeys(payload.inputs);

    return {
      ok: true,
      invalidUrl: false,
      inputs: nextInputs,
      config: sanitizeControllerConfig(payload, nextInputs)
    };
  } catch {
    return { ok: false, invalidUrl: false, inputs: [], config: null };
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

  if (!navigator.onLine) {
    setReconnectVisible(true);
    setStatus('offline. waiting for network', 'retrying');
    return;
  }

  retryAttempts += 1;
  const retryDelayMs = getRetryDelayMs();
  retrySecondsRemaining = Math.max(1, Math.ceil(retryDelayMs / 1000));
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
  }, retryDelayMs);
}

function sendState() {
  if (!controlsReady || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
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
    return false;
  }

  state[key] = pressed;
  button.classList.toggle('active', pressed);
  sendState();
  return true;
}

function roundAxisValue(value) {
  return Math.round(value * STICK_AXIS_PRECISION) / STICK_AXIS_PRECISION;
}

function applyStickResponse(x, y) {
  const magnitude = Math.min(1, Math.hypot(x, y));
  if (magnitude <= STICK_DEADZONE) {
    return { x: 0, y: 0 };
  }

  const normalizedMagnitude = (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const curvedMagnitude = normalizedMagnitude ** STICK_RESPONSE_EXPONENT;
  const scale = curvedMagnitude / magnitude;
  return {
    x: x * scale,
    y: y * scale
  };
}

function setAnalogStickState(axisX, axisY, smoothElement = null, vibrateOnPress = true) {
  const nextAxisX = roundAxisValue(axisX);
  const nextAxisY = roundAxisValue(axisY);
  let changed = false;
  let pressedDirection = false;

  if (state.axisX !== nextAxisX) {
    state.axisX = nextAxisX;
    changed = true;
  }

  if (state.axisY !== nextAxisY) {
    state.axisY = nextAxisY;
    changed = true;
  }

  const nextDirections = {
    left: nextAxisX < -DIRECTION_THRESHOLD,
    right: nextAxisX > DIRECTION_THRESHOLD,
    up: nextAxisY < -DIRECTION_THRESHOLD,
    down: nextAxisY > DIRECTION_THRESHOLD
  };

  for (const direction of DIRECTION_KEYS) {
    const mappedKey = directionKeys[direction];
    if (!mappedKey) {
      continue;
    }

    const nextValue = Boolean(nextDirections[direction]);
    if (state[mappedKey] === nextValue) {
      continue;
    }

    if (nextValue) {
      pressedDirection = true;
    }

    state[mappedKey] = nextValue;
    changed = true;
  }

  if (smoothElement) {
    for (const direction of DIRECTION_KEYS) {
      smoothElement.classList.toggle(`active-${direction}`, Boolean(nextDirections[direction]));
    }
  }

  if (!changed) {
    return;
  }

  sendState();
  if (vibrateOnPress && pressedDirection) {
    triggerHaptic('light');
  }
}

function bindButton(button, key) {
  const press = (event) => {
    event.preventDefault();
    if (event.pointerId !== undefined) {
      button.setPointerCapture(event.pointerId);
    }

    if (setButtonState(button, key, true)) {
      triggerHaptic('light');
    }
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

function createControlButton(key, dpadSlot = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'control-btn';
  button.dataset.key = key;
  button.textContent = getControlLabel(key);

  if (dpadSlot) {
    button.classList.add('dpad-btn');
    button.dataset.slot = dpadSlot;
  } else {
    button.classList.add('action-btn');
  }

  bindButton(button, key);
  return button;
}

function clearSmoothStick() {
  if (typeof smoothCleanup === 'function') {
    smoothCleanup();
  }

  smoothCleanup = null;
}

function createSmoothStick() {
  const container = document.createElement('div');
  container.className = 'smooth-stick';
  container.dataset.active = '0';

  const axisHorizontal = document.createElement('div');
  axisHorizontal.className = 'smooth-axis smooth-axis-x';
  const axisVertical = document.createElement('div');
  axisVertical.className = 'smooth-axis smooth-axis-y';
  const ring = document.createElement('div');
  ring.className = 'smooth-ring';
  const knob = document.createElement('div');
  knob.className = 'smooth-knob';

  container.appendChild(axisHorizontal);
  container.appendChild(axisVertical);
  container.appendChild(ring);
  container.appendChild(knob);

  let activePointerId = null;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let animationFrameId = 0;
  const abortController = new AbortController();
  const listenerOptions = { signal: abortController.signal };

  const updateKnob = (dx, dy) => {
    knob.style.transform = `translate(calc(-50% + ${Math.round(dx)}px), calc(-50% + ${Math.round(dy)}px))`;
  };

  const resetStick = () => {
    container.dataset.active = '0';
    targetX = 0;
    targetY = 0;
    ensureAnimation();
  };

  const ensureAnimation = () => {
    if (animationFrameId) {
      return;
    }

    const step = () => {
      const deltaX = targetX - currentX;
      const deltaY = targetY - currentY;
      currentX += deltaX * STICK_SMOOTHING;
      currentY += deltaY * STICK_SMOOTHING;

      if (Math.abs(targetX - currentX) < 0.002) {
        currentX = targetX;
      }

      if (Math.abs(targetY - currentY) < 0.002) {
        currentY = targetY;
      }

      const visualRadius = Math.max(1, Math.min(container.clientWidth, container.clientHeight) / 2 - 16);
      updateKnob(currentX * visualRadius, currentY * visualRadius);
      setAnalogStickState(currentX, currentY, container, true);

      if (currentX !== targetX || currentY !== targetY || activePointerId !== null) {
        animationFrameId = requestAnimationFrame(step);
        return;
      }

      animationFrameId = 0;
    };

    animationFrameId = requestAnimationFrame(step);
  };

  const applyPointer = (event) => {
    const rect = container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2 - 16);

    let dx = event.clientX - centerX;
    let dy = event.clientY - centerY;
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      const scale = radius / distance;
      dx *= scale;
      dy *= scale;
    }

    container.dataset.active = '1';
    const normalizedX = dx / radius;
    const normalizedY = dy / radius;
    const curved = applyStickResponse(normalizedX, normalizedY);
    targetX = curved.x;
    targetY = curved.y;
    ensureAnimation();
  };

  container.addEventListener(
    'pointerdown',
    (event) => {
      event.preventDefault();
      activePointerId = event.pointerId;
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // Some browsers reject pointer capture on edge cases.
      }
      applyPointer(event);
      triggerHaptic('strong');
    },
    listenerOptions
  );

  container.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerId !== activePointerId) {
        return;
      }

      event.preventDefault();
      applyPointer(event);
    },
    listenerOptions
  );

  const release = (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }

    event.preventDefault();
    activePointerId = null;
    resetStick();
  };

  container.addEventListener('pointerup', release, listenerOptions);
  container.addEventListener('pointercancel', release, listenerOptions);
  container.addEventListener(
    'pointerleave',
    (event) => {
      if (event.pointerId !== activePointerId || event.buttons !== 0) {
        return;
      }

      release(event);
    },
    listenerOptions
  );
  container.addEventListener('contextmenu', (event) => event.preventDefault(), listenerOptions);

  resetStick();

  return {
    element: container,
    cleanup: () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = 0;
      }
      abortController.abort();
      activePointerId = null;
      currentX = 0;
      currentY = 0;
      if (Object.hasOwn(state, 'axisX')) {
        state.axisX = 0;
      }
      if (Object.hasOwn(state, 'axisY')) {
        state.axisY = 0;
      }
    }
  };
}

function renderControls() {
  clearSmoothStick();
  dpadElement.classList.remove('smooth-host');

  dpadElement.innerHTML = '';
  actionsElement.innerHTML = '';
  extrasElement.innerHTML = '';

  const hasDirections = DIRECTION_KEYS.some((direction) => Boolean(directionKeys[direction]));
  if (controllerConfig.joystickMode === 'dpad' && hasDirections) {
    for (const direction of DIRECTION_KEYS) {
      const key = directionKeys[direction];
      if (!key) {
        continue;
      }

      dpadElement.appendChild(createControlButton(key, direction));
    }
  } else if (controllerConfig.joystickMode === 'smooth' && hasDirections) {
    dpadElement.classList.add('smooth-host');
    const smoothStick = createSmoothStick();
    dpadElement.appendChild(smoothStick.element);
    smoothCleanup = smoothStick.cleanup;
  }

  const requestedButtons = sanitizeButtons(controllerConfig.buttons, inputKeys);
  const defaultButtons = inputKeys.filter((key) => !isDpadKey(key));
  const primaryButtons = (requestedButtons.length > 0 ? requestedButtons : defaultButtons).slice(0, 8);

  const extras = [];
  const primarySet = new Set(primaryButtons);

  for (const key of inputKeys) {
    if (isDpadKey(key) || primarySet.has(key)) {
      continue;
    }

    extras.push(key);
  }

  for (const key of primaryButtons) {
    actionsElement.appendChild(createControlButton(key));
  }

  for (const key of extras) {
    extrasElement.appendChild(createControlButton(key));
  }

  extrasElement.hidden = extras.length === 0;
  dpadElement.hidden = dpadElement.children.length === 0;
  actionsElement.hidden = actionsElement.children.length === 0;
}

async function connectWebSocket() {
  if (!controlsReady || connectAttemptInFlight) {
    return;
  }

  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  connectAttemptInFlight = true;
  clearRetryTimers();
  setReconnectVisible(false);
  setStatus('trying to connect...', 'connecting');
  const activeSocket = new WebSocket(buildWsUrl());
  socket = activeSocket;

  let opened = false;

  activeSocket.addEventListener('open', () => {
    if (socket !== activeSocket) {
      return;
    }

    opened = true;
    connectAttemptInFlight = false;
    clearRetryTimers();
    retryAttempts = 0;
    setReconnectVisible(false);
    setStatus('connected', 'connected');
    sendState();
  });

  activeSocket.addEventListener('close', async () => {
    if (socket !== activeSocket) {
      return;
    }

    socket = null;
    connectAttemptInFlight = false;

    const reason = opened ? 'disconnected' : 'failed to connect';
    if (!opened && retryAttempts >= RETRY_CHECK_AUTH_AFTER) {
      const postCloseCheck = await checkControllerUrl();
      if (socket !== null) {
        return;
      }

      if (postCloseCheck.invalidUrl) {
        setReconnectVisible(false);
        setStatus('invalid controller URL (missing or wrong token)', 'error');
        return;
      }
    }

    scheduleRetry(reason, connectWebSocket);
  });

  activeSocket.addEventListener('error', () => {
    if (socket !== activeSocket || opened) {
      return;
    }

    setStatus('connection failed', 'disconnected');
  });
}

async function initController() {
  setStatus('loading controller...', 'connecting');
  setReconnectVisible(false);

  const config = await loadControllerConfig();
  if (config.invalidUrl) {
    retryAttempts = 0;
    setStatus('invalid controller URL (missing or wrong token)', 'error');
    return;
  }

  if (!config.ok || !config.config) {
    scheduleRetry('failed to load controller config', initController);
    return;
  }

  inputKeys = config.inputs;
  state = createState(inputKeys);
  directionKeys = resolveDirectionKeys(inputKeys);
  controllerConfig = config.config;
  hapticsEnabled = controllerConfig.haptics;

  renderControls();
  setLayoutInfo();
  updateDeviceNote();

  controlsReady = true;
  retryAttempts = 0;
  connectWebSocket();
}

reconnectButton.addEventListener('click', () => {
  clearRetryTimers();
  retryAttempts = 0;

  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
});

fullscreenButton.addEventListener('click', () => {
  enterFullscreen();
});

window.addEventListener('offline', () => {
  clearRetryTimers();
  setReconnectVisible(true);
  setStatus('offline. waiting for network', 'retrying');
});

window.addEventListener('online', () => {
  clearRetryTimers();
  retryAttempts = 0;
  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
});

document.addEventListener('fullscreenchange', () => {
  updateFullscreenButton();
});
document.addEventListener('webkitfullscreenchange', () => {
  updateFullscreenButton();
});

window.addEventListener('resize', () => {
  syncViewportMetrics();
  updateFullscreenButton();
});
window.addEventListener('orientationchange', () => {
  syncViewportMetrics();
  updateFullscreenButton();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportMetrics);
  window.visualViewport.addEventListener('scroll', syncViewportMetrics);
}

const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
standaloneQuery?.addEventListener?.('change', () => {
  updateFullscreenButton();
  updateDeviceNote();
  syncViewportMetrics();
});

document.addEventListener(
  'pointerdown',
  () => {
    if (attemptedAutoFullscreen) {
      return;
    }

    attemptedAutoFullscreen = true;
    enterFullscreen();
  },
  { passive: true }
);

setInterval(sendState, KEEPALIVE_INTERVAL_MS);
syncRuntimeEnvironment();
syncViewportMetrics();
updateFullscreenButton();
setLayoutInfo();
updateDeviceNote();
initController();
