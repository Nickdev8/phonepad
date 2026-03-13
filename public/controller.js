const statusElement = document.getElementById('status');
const serverConnectionElement = document.getElementById('server-connection');
const laptopConnectionElement = document.getElementById('laptop-connection');
const layoutInfoElement = document.getElementById('layout-info');
const deviceNoteElement = document.getElementById('device-note');
const takeControlButton = document.getElementById('take-control');
const fullscreenButton = document.getElementById('fullscreen-toggle');
const reconnectButton = document.getElementById('reconnect-now');
const topElement = document.querySelector('.top');
const appElement = document.querySelector('.app');
const dpadElement = document.getElementById('dpad');
const actionsElement = document.getElementById('actions');
const extrasElement = document.getElementById('extras');

const DEVICE_STORAGE_KEY = 'phonepad_device_id';
const TOKEN_STORAGE_KEY = 'phonepad_session_token';
const LEGACY_TOKEN_STORAGE_KEY = 'phonepad_access_token';
const AUTH_CHECK_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 1000 / 12;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 3000;
const RETRY_JITTER_MS = 150;
const RETRY_CHECK_AUTH_AFTER = 3;
const MAX_BUFFERED_BYTES = 128 * 1024;
const HAPTIC_MIN_INTERVAL_MS = 25;
const FEEDBACK_FLASH_MS = 90;
const SWITCH_HAPTIC_STRONG_REPEAT_MS = 34;
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
const PRESET_ACTION_METADATA = Object.freeze({
  'ultimate-chicken-horse': Object.freeze({
    labels: Object.freeze({
      A: 'Jump',
      B: 'Back',
      X: 'Sprint',
      Y: 'Dance'
    }),
    actionsClassName: 'preset-ultimate-chicken-horse'
  })
});

const urlParams = new URLSearchParams(window.location.search);
const token = resolveAccessToken(urlParams);
const deviceId = getOrCreateDeviceId();
const tabSessionId = createTabSessionId();
const TAB_OWNERSHIP_STORAGE_KEY = `phonepad_active_tab:${deviceId}`;
const isAppleMobile = detectAppleMobile();
const isAndroidPhone = detectAndroidPhone();
const nativeVibrationSupported = typeof navigator.vibrate === 'function';
const appleSwitchHapticsSupported = detectAppleSwitchHapticsSupport();

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
let hapticsEnabled = true;
let lastHapticAt = 0;
let feedbackFlashTimer = 0;
let smoothCleanup = null;
let standaloneMode = detectStandaloneMode();
let switchHapticInput = null;
let switchHapticLabel = null;
let switchHapticTimer = 0;
let fullscreenRequestInFlight = false;
let deviceNoteText = '';
let laptopObserverCount = 0;
let tabOwnsController = false;

function createDeviceId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `phonepad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTabSessionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

  if (fromQuery) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
    } catch {}

    try {
      localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
    } catch {}

    return fromQuery;
  }

  try {
    const fromSession = (sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '').trim();
    if (fromSession) {
      return fromSession;
    }
  } catch {}

  try {
    const legacyToken = (localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY) ?? '').trim();
    if (legacyToken) {
      try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, legacyToken);
      } catch {}

      localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
      return legacyToken;
    }
  } catch {}

  return '';
}

function detectAppleMobile() {
  const userAgent = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  return /iPad|iPhone|iPod/u.test(userAgent) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function detectAndroidPhone() {
  const userAgent = navigator.userAgent ?? '';
  return /Android/u.test(userAgent) && /Mobile/u.test(userAgent);
}

function detectStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function detectAppleSwitchHapticsSupport() {
  if (!isAppleMobile) {
    return false;
  }

  const userAgent = navigator.userAgent ?? '';
  const osMatch = userAgent.match(/OS (\d+)_/u);
  if (osMatch) {
    return Number(osMatch[1]) >= 18;
  }

  const versionMatch = userAgent.match(/Version\/(\d+)(?:\.\d+)?/u);
  return Boolean(versionMatch && Number(versionMatch[1]) >= 18);
}

function supportsNativeHaptics() {
  return nativeVibrationSupported;
}

function supportsSwitchHaptics() {
  return appleSwitchHapticsSupported;
}

function supportsAnyHaptics() {
  return supportsNativeHaptics() || supportsSwitchHaptics();
}

function syncRuntimeEnvironment() {
  standaloneMode = detectStandaloneMode();
  appElement.classList.toggle('ios-browser', isAppleMobile && !standaloneMode);
  appElement.classList.toggle('ios-standalone', isAppleMobile && standaloneMode);
}

function hasVisibleTopActions() {
  return !takeControlButton.hidden || !reconnectButton.hidden || !fullscreenButton.hidden;
}

function isLandscapeViewport() {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return width > height;
}

function isCompactLandscapeViewport() {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return width > height && Math.min(width, height) < 560;
}

function syncTopChrome() {
  const landscapeCompact = isCompactLandscapeViewport();

  appElement.classList.toggle('landscape-compact', landscapeCompact);

  if (topElement) {
    topElement.hidden = false;
  }

  syncDeviceNoteVisibility();
  syncViewportMetrics();
}

function getFullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function supportsFullscreenMode() {
  return Boolean(
    document.fullscreenEnabled ||
      document.webkitFullscreenEnabled ||
      appElement.requestFullscreen ||
      appElement.webkitRequestFullscreen
  );
}

function shouldAutoEnterAndroidFullscreen() {
  return isAndroidPhone && !standaloneMode && supportsFullscreenMode();
}

function shouldShowAndroidFullscreenButton() {
  return shouldAutoEnterAndroidFullscreen() && !getFullscreenElement();
}

function syncFullscreenButton() {
  if (!fullscreenButton) {
    return;
  }

  fullscreenButton.hidden = !shouldShowAndroidFullscreenButton();
  syncTopChrome();
}

function readTabOwnership() {
  try {
    const rawValue = localStorage.getItem(TAB_OWNERSHIP_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tabId !== 'string') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeTabOwnership() {
  try {
    localStorage.setItem(
      TAB_OWNERSHIP_STORAGE_KEY,
      JSON.stringify({
        tabId: tabSessionId,
        updatedAt: Date.now()
      })
    );
  } catch {
    // Storage access is best effort only.
  }
}

function clearTabOwnership() {
  try {
    const currentOwner = readTabOwnership();
    if (currentOwner?.tabId === tabSessionId) {
      localStorage.removeItem(TAB_OWNERSHIP_STORAGE_KEY);
    }
  } catch {
    // Storage access is best effort only.
  }
}

function closeControllerSocket() {
  clearRetryTimers();
  connectAttemptInFlight = false;

  const activeSocket = socket;
  socket = null;
  if (!activeSocket) {
    return;
  }

  if (activeSocket.readyState === WebSocket.CONNECTING || activeSocket.readyState === WebSocket.OPEN) {
    try {
      activeSocket.close(4000, 'inactive_tab');
    } catch {
      // Ignore close races during tab handoff.
    }
  }
}

function setTabOwnershipState(isOwner) {
  if (tabOwnsController === isOwner) {
    appElement.classList.toggle('tab-inactive', !isOwner);
    takeControlButton.hidden = isOwner;
    syncTopChrome();
    return;
  }

  tabOwnsController = isOwner;
  appElement.classList.toggle('tab-inactive', !isOwner);
  takeControlButton.hidden = isOwner;

  if (!isOwner) {
    closeControllerSocket();
    syncTopChrome();
    return;
  }

  syncTopChrome();
  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
}

function claimControllerOwnership() {
  if (document.visibilityState !== 'visible') {
    setTabOwnershipState(false);
    return false;
  }

  writeTabOwnership();
  setTabOwnershipState(true);
  return true;
}

function releaseControllerOwnership() {
  clearTabOwnership();
  setTabOwnershipState(false);
}

async function tryEnterAndroidFullscreen() {
  if (!shouldAutoEnterAndroidFullscreen() || fullscreenRequestInFlight || getFullscreenElement()) {
    return false;
  }

  const requestFullscreen =
    appElement.requestFullscreen?.bind(appElement) ??
    appElement.webkitRequestFullscreen?.bind(appElement);

  if (!requestFullscreen) {
    return false;
  }

  fullscreenRequestInFlight = true;
  let enteredFullscreen = false;
  try {
    await requestFullscreen({ navigationUI: 'hide' });
    enteredFullscreen = Boolean(getFullscreenElement());
  } catch {
    try {
      await requestFullscreen();
      enteredFullscreen = Boolean(getFullscreenElement());
    } catch {
      // Ignore browsers that reject fullscreen outside a qualifying gesture.
    }
  } finally {
    fullscreenRequestInFlight = false;
    syncFullscreenButton();
    syncViewportMetrics();
    syncTopChrome();
  }

  return enteredFullscreen;
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

function getPresetActionMetadata() {
  return PRESET_ACTION_METADATA[controllerConfig.preset] ?? null;
}

function getActionLabel(key) {
  const metadata = getPresetActionMetadata();
  if (!metadata) {
    return '';
  }

  return metadata.labels[key] ?? '';
}

function setStatus(text, type) {
  if (!statusElement) {
    return;
  }

  statusElement.textContent = text;
  statusElement.className = `status ${type}`;
}

function setConnectionBadge(element, state, text) {
  if (!element) {
    return;
  }

  element.className = `connection-badge ${state}`;
  element.setAttribute('aria-label', text);
  element.setAttribute('title', text);
}

function setServerConnectionState(state) {
  const labelByState = {
    connected: 'Server: connected',
    connecting: 'Server: connecting',
    disconnected: 'Server: disconnected',
    retrying: 'Server: reconnecting',
    error: 'Server: error'
  };

  setConnectionBadge(serverConnectionElement, state, labelByState[state] ?? 'Server: unknown');
}

function setLaptopConnectionState(state, observerCount = laptopObserverCount) {
  laptopObserverCount = observerCount;

  if (state === 'connected') {
    const label = observerCount > 1 ? `Laptop: ${observerCount} connected` : 'Laptop: connected';
    setConnectionBadge(laptopConnectionElement, state, label);
    return;
  }

  if (state === 'waiting') {
    setConnectionBadge(laptopConnectionElement, state, 'Laptop: waiting');
    return;
  }

  if (state === 'disconnected') {
    setConnectionBadge(laptopConnectionElement, state, 'Laptop: unavailable');
    return;
  }

  setConnectionBadge(laptopConnectionElement, state, 'Laptop: checking');
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
  const hapticLabel = !controllerConfig.haptics ? 'off' : supportsAnyHaptics() ? 'on' : 'visual only';
  layoutInfoElement.textContent = `${controllerConfig.preset} | ${joystickLabel} | ${buttonText} | haptics ${hapticLabel}`;
}

function setDeviceNote(text) {
  if (!deviceNoteElement) {
    return;
  }

  deviceNoteText = String(text ?? '').trim();
  deviceNoteElement.textContent = deviceNoteText;
  syncDeviceNoteVisibility();
}

function syncDeviceNoteVisibility() {
  if (!deviceNoteElement) {
    return;
  }

  deviceNoteElement.hidden = deviceNoteText.length === 0 || isLandscapeViewport();
}

function updateDeviceNote() {
  syncRuntimeEnvironment();

  const notes = [];
  if (controllerConfig.haptics && !supportsNativeHaptics()) {
    if (isAppleMobile) {
      if (supportsSwitchHaptics()) {
        notes.push('Safari does not expose web vibration here, so PhonePad uses Safari switch haptics on supported Apple devices.');
      } else {
        notes.push('Safari does not expose web vibration here, so haptics fall back to visual feedback.');
      }
    } else {
      notes.push('This browser does not expose vibration, so haptics fall back to visual feedback.');
    }
  }

  setDeviceNote(notes.join(' '));
}

function setReconnectVisible(visible) {
  reconnectButton.hidden = !visible;
  syncTopChrome();
}

function flashFeedback(intensity = 'light') {
  document.body.dataset.feedback = intensity;
  clearTimeout(feedbackFlashTimer);
  feedbackFlashTimer = setTimeout(() => {
    delete document.body.dataset.feedback;
  }, FEEDBACK_FLASH_MS);
}

function pulseSwitchHaptic() {
  if (!ensureSwitchHapticProxy()) {
    return false;
  }

  switchHapticInput.checked = !switchHapticInput.checked;
  switchHapticLabel.click();
  return true;
}

function ensureSwitchHapticProxy() {
  if (!supportsSwitchHaptics()) {
    return false;
  }

  if (switchHapticInput && switchHapticLabel) {
    return true;
  }

  const host = document.createElement('div');
  host.className = 'haptic-switch-proxy';
  host.setAttribute('aria-hidden', 'true');

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `phonepad-switch-haptic-${deviceId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24)}`;
  input.className = 'haptic-switch-proxy-input';
  input.tabIndex = -1;
  input.setAttribute('switch', '');

  const label = document.createElement('label');
  label.className = 'haptic-switch-proxy-label';
  label.htmlFor = input.id;
  label.setAttribute('aria-hidden', 'true');
  label.textContent = 'PhonePad haptic proxy';

  host.append(input, label);
  document.body.append(host);

  switchHapticInput = input;
  switchHapticLabel = label;
  return true;
}

function triggerSwitchHaptic(intensity = 'light') {
  if (!pulseSwitchHaptic()) {
    return false;
  }

  clearTimeout(switchHapticTimer);
  switchHapticTimer = 0;

  if (intensity === 'strong') {
    switchHapticTimer = setTimeout(() => {
      switchHapticTimer = 0;
      if (!hapticsEnabled) {
        return;
      }

      pulseSwitchHaptic();
    }, SWITCH_HAPTIC_STRONG_REPEAT_MS);
  }

  return true;
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
    navigator.vibrate(intensity === 'strong' ? [14, 18, 18] : 8);
    return;
  }

  if (triggerSwitchHaptic(intensity)) {
    flashFeedback(intensity);
    return;
  }

  flashFeedback(intensity);
}

function syncViewportMetrics() {
  const viewportWidth = Math.round(window.visualViewport?.width ?? window.innerWidth);
  const viewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);
  const landscape = viewportWidth > viewportHeight;
  const landscapeCompact = isCompactLandscapeViewport();
  const topHeight = Math.ceil(topElement?.getBoundingClientRect().height ?? 0);
  const shortestSide = Math.min(viewportWidth, viewportHeight);
  const gap = Math.max(10, Math.min(20, Math.round(shortestSide * 0.024)));
  const availableWidth = Math.max(220, viewportWidth - 24);
  const availableHeight = Math.max(
    220,
    viewportHeight - 24 - (landscapeCompact ? 0 : topHeight)
  );

  let dpadSize;
  let actionSize;

  if (landscape) {
    dpadSize = Math.max(
      140,
      Math.min(
        availableWidth * (landscapeCompact ? 0.36 : 0.34),
        availableHeight * (landscapeCompact ? 0.88 : 0.72),
        520
      )
    );

    const actionAreaWidth = Math.max(140, availableWidth - dpadSize - gap);
    actionSize = Math.max(
      64,
      Math.min(
        (actionAreaWidth - gap) / 2,
        (availableHeight - gap) / 2,
        landscapeCompact ? 220 : 280
      )
    );
  } else {
    dpadSize = Math.max(
      180,
      Math.min(
        availableWidth * 0.94,
        availableHeight * 0.5,
        520
      )
    );

    const actionAreaHeight = Math.max(140, availableHeight - dpadSize - gap);
    actionSize = Math.max(
      78,
      Math.min(
        (availableWidth - gap) / 2,
        (actionAreaHeight - gap) / 2,
        280
      )
    );
  }

  const actionsWidth = actionSize * 2 + gap;
  const controllerMaxWidth = landscape
    ? Math.min(availableWidth, dpadSize + actionsWidth + gap)
    : Math.min(availableWidth, Math.max(dpadSize, actionsWidth));

  document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`);
  document.documentElement.style.setProperty('--app-width', `${viewportWidth}px`);
  document.documentElement.style.setProperty('--top-height', `${topHeight}px`);
  document.documentElement.style.setProperty('--control-gap', `${gap}px`);
  document.documentElement.style.setProperty('--dpad-size', `${Math.round(dpadSize)}px`);
  document.documentElement.style.setProperty('--action-size', `${Math.round(actionSize)}px`);
  document.documentElement.style.setProperty('--actions-width', `${Math.round(actionsWidth)}px`);
  document.documentElement.style.setProperty('--controller-max-width', `${Math.round(controllerMaxWidth)}px`);
  document.documentElement.style.setProperty(
    '--controller-top-clearance',
    `${landscapeCompact ? Math.min(topHeight + 6, Math.max(0, viewportHeight * 0.22)) : 0}px`
  );
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

  if (!tabOwnsController) {
    return;
  }

  if (!navigator.onLine) {
    setReconnectVisible(true);
    setStatus('offline. waiting for network', 'retrying');
    setServerConnectionState('disconnected');
    setLaptopConnectionState('disconnected', 0);
    return;
  }

  retryAttempts += 1;
  const retryDelayMs = getRetryDelayMs();
  retrySecondsRemaining = Math.max(1, Math.ceil(retryDelayMs / 1000));
  setReconnectVisible(true);
  setStatus(`${reason}. retrying in ${retrySecondsRemaining}s`, 'retrying');
  setServerConnectionState('retrying');
  setLaptopConnectionState('waiting', 0);

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
  if (!tabOwnsController || !controlsReady || !socket || socket.readyState !== WebSocket.OPEN) {
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

  if (dpadSlot) {
    button.classList.add('dpad-btn');
    button.dataset.slot = dpadSlot;
    button.textContent = getControlLabel(key);
  } else {
    button.classList.add('action-btn');
    const actionLabel = getActionLabel(key);
    if (actionLabel) {
      button.classList.add('action-btn-labeled');
      button.setAttribute('aria-label', `${getControlLabel(key)} ${actionLabel}`);
      button.setAttribute('title', `${getControlLabel(key)} ${actionLabel}`);

      const keyLabel = document.createElement('span');
      keyLabel.className = 'action-btn-key';
      keyLabel.textContent = getControlLabel(key);

      const nameLabel = document.createElement('span');
      nameLabel.className = 'action-btn-name';
      nameLabel.textContent = actionLabel;

      button.appendChild(keyLabel);
      button.appendChild(nameLabel);
    } else {
      button.textContent = getControlLabel(key);
    }
  }

  bindButton(button, key);
  return button;
}

function createDpadCore() {
  const core = document.createElement('div');
  core.className = 'dpad-core';
  core.setAttribute('aria-hidden', 'true');
  return core;
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
      // Pointer capture is opportunistic: some mobile browsers reject it mid-gesture.
      try {
        container.setPointerCapture(event.pointerId);
      } catch {}
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
  actionsElement.className = 'actions';

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

    dpadElement.appendChild(createDpadCore());
  } else if (controllerConfig.joystickMode === 'smooth' && hasDirections) {
    dpadElement.classList.add('smooth-host');
    const smoothStick = createSmoothStick();
    dpadElement.appendChild(smoothStick.element);
    smoothCleanup = smoothStick.cleanup;
  }

  const requestedButtons = sanitizeButtons(controllerConfig.buttons, inputKeys);
  const defaultButtons = inputKeys.filter((key) => !isDpadKey(key));
  const primaryButtons = (requestedButtons.length > 0 ? requestedButtons : defaultButtons).slice(0, 8);
  const presetActionMetadata = getPresetActionMetadata();
  if (presetActionMetadata?.actionsClassName) {
    actionsElement.classList.add(presetActionMetadata.actionsClassName);
  }

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
  if (!tabOwnsController || !controlsReady || connectAttemptInFlight) {
    return;
  }

  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  connectAttemptInFlight = true;
  clearRetryTimers();
  setReconnectVisible(false);
  setStatus('trying to connect...', 'connecting');
  setServerConnectionState('connecting');
  setLaptopConnectionState('waiting', 0);
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
    setServerConnectionState('connected');
    setLaptopConnectionState('waiting', 0);
    sendState();
  });

  activeSocket.addEventListener('message', (event) => {
    if (socket !== activeSocket) {
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'bridge_status') {
      const observerCount = Number.isSafeInteger(message.observerCount) ? message.observerCount : 0;
      setLaptopConnectionState(message.connected ? 'connected' : 'waiting', observerCount);
    }
  });

  activeSocket.addEventListener('close', async () => {
    if (socket !== activeSocket) {
      return;
    }

    socket = null;
    connectAttemptInFlight = false;
    setServerConnectionState('disconnected');
    setLaptopConnectionState('disconnected', 0);

    const reason = opened ? 'disconnected' : 'failed to connect';
    if (!opened && retryAttempts >= RETRY_CHECK_AUTH_AFTER) {
      const postCloseCheck = await checkControllerUrl();
      if (socket !== null) {
        return;
      }

      if (postCloseCheck.invalidUrl) {
        setReconnectVisible(false);
        setStatus('invalid controller URL (missing or wrong token)', 'error');
        setServerConnectionState('error');
        setLaptopConnectionState('disconnected', 0);
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
    setServerConnectionState('disconnected');
    setLaptopConnectionState('disconnected', 0);
  });
}

async function initController() {
  if (!tabOwnsController) {
    return;
  }

  setStatus('loading controller...', 'connecting');
  setReconnectVisible(false);
  setServerConnectionState('connecting');
  setLaptopConnectionState('waiting', 0);

  const config = await loadControllerConfig();
  if (config.invalidUrl) {
    retryAttempts = 0;
    setStatus('invalid controller URL (missing or wrong token)', 'error');
    setServerConnectionState('error');
    setLaptopConnectionState('disconnected', 0);
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

  ensureSwitchHapticProxy();
  renderControls();
  setLayoutInfo();
  updateDeviceNote();
  syncTopChrome();

  controlsReady = true;
  retryAttempts = 0;
  connectWebSocket();
}

reconnectButton.addEventListener('click', () => {
  if (!tabOwnsController) {
    claimControllerOwnership();
    return;
  }

  tryEnterAndroidFullscreen();
  clearRetryTimers();
  retryAttempts = 0;

  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
});

fullscreenButton?.addEventListener('click', async () => {
  await tryEnterAndroidFullscreen();
});

takeControlButton?.addEventListener('click', () => {
  claimControllerOwnership();
});

window.addEventListener('offline', () => {
  clearRetryTimers();
  setReconnectVisible(true);
  setStatus('offline. waiting for network', 'retrying');
  setServerConnectionState('disconnected');
  setLaptopConnectionState('disconnected', 0);
});

window.addEventListener('online', () => {
  if (!tabOwnsController) {
    return;
  }

  clearRetryTimers();
  retryAttempts = 0;
  setServerConnectionState('connecting');
  setLaptopConnectionState('waiting', 0);
  if (!controlsReady) {
    initController();
    return;
  }

  connectWebSocket();
});

window.addEventListener('resize', () => {
  syncFullscreenButton();
  syncViewportMetrics();
  syncTopChrome();
});
window.addEventListener('orientationchange', () => {
  syncFullscreenButton();
  syncViewportMetrics();
  syncTopChrome();
});
window.addEventListener('fullscreenchange', () => {
  syncFullscreenButton();
  syncViewportMetrics();
  syncTopChrome();
});
window.addEventListener('webkitfullscreenchange', () => {
  syncFullscreenButton();
  syncViewportMetrics();
  syncTopChrome();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    syncViewportMetrics();
    syncTopChrome();
  });
  window.visualViewport.addEventListener('scroll', syncViewportMetrics);
}

const standaloneQuery = window.matchMedia?.('(display-mode: standalone)');
standaloneQuery?.addEventListener?.('change', () => {
  updateDeviceNote();
  syncFullscreenButton();
  syncViewportMetrics();
  syncTopChrome();
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    claimControllerOwnership();
    return;
  }

  releaseControllerOwnership();
});

window.addEventListener('pagehide', () => {
  releaseControllerOwnership();
});

window.addEventListener('storage', (event) => {
  if (event.key !== TAB_OWNERSHIP_STORAGE_KEY) {
    return;
  }

  const owner = event.newValue ? readTabOwnership() : null;
  if (!owner) {
    if (document.visibilityState === 'visible') {
      claimControllerOwnership();
      return;
    }

    setTabOwnershipState(false);
    return;
  }

  if (owner.tabId === tabSessionId) {
    setTabOwnershipState(true);
    return;
  }

  if (document.visibilityState === 'visible') {
    claimControllerOwnership();
    return;
  }

  setTabOwnershipState(false);
});

const handleAndroidFullscreenGesture = async () => {
  const enteredFullscreen = await tryEnterAndroidFullscreen();
  if (!enteredFullscreen) {
    return;
  }

  document.removeEventListener('pointerup', handleAndroidFullscreenGesture);
};

document.addEventListener('pointerup', handleAndroidFullscreenGesture, { passive: true });

setInterval(sendState, KEEPALIVE_INTERVAL_MS);
syncRuntimeEnvironment();
syncFullscreenButton();
syncViewportMetrics();
setLayoutInfo();
updateDeviceNote();
syncTopChrome();
setServerConnectionState('connecting');
setLaptopConnectionState('waiting', 0);
claimControllerOwnership();
