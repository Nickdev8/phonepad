#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

const DIRECTION_KEYS = Object.freeze(['up', 'down', 'left', 'right']);
const DIRECTION_SET = new Set(DIRECTION_KEYS);
const JOYSTICK_MODES = new Set(['dpad', 'smooth', 'none']);
const LAYOUT_PRESETS = Object.freeze({
  classic: {
    category: 'base',
    description: 'D-pad + A/B',
    joystickMode: 'dpad',
    buttons: ['A', 'B']
  },
  arcade: {
    category: 'base',
    description: 'D-pad + A/B/X/Y',
    joystickMode: 'dpad',
    buttons: ['A', 'B', 'X', 'Y']
  },
  shooter: {
    category: 'base',
    description: 'Smooth stick + A/B/X/Y',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'X', 'Y']
  },
  driving: {
    category: 'base',
    description: 'Smooth stick + A/B/L1/R1',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'L1', 'R1']
  },
  minimal: {
    category: 'base',
    description: 'D-pad + A',
    joystickMode: 'dpad',
    buttons: ['A']
  },
  'ultimate-chicken-horse': {
    category: 'game',
    description: 'Ultimate Chicken Horse profile',
    joystickMode: 'dpad',
    buttons: ['A', 'B', 'X', 'Y']
  },
  'pico-park': {
    category: 'game',
    description: 'PICO PARK profile',
    joystickMode: 'dpad',
    buttons: ['A', 'B']
  },
  'boomerang-fu': {
    category: 'game',
    description: 'Boomerang Fu profile',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'X', 'Y']
  },
  'ibb-obb': {
    category: 'game',
    description: 'ibb & obb profile',
    joystickMode: 'dpad',
    buttons: ['A', 'B']
  },
  plateup: {
    category: 'game',
    description: 'PlateUp! profile',
    joystickMode: 'dpad',
    buttons: ['A', 'B', 'X', 'Y']
  },
  unrailed: {
    category: 'game',
    description: 'Unrailed! profile',
    joystickMode: 'dpad',
    buttons: ['A', 'B', 'X', 'Y']
  },
  stickfight: {
    category: 'game',
    description: 'Stick Fight: The Game profile',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'X', 'Y']
  }
});
const LAYOUT_PRESET_ALIASES = Object.freeze({
  uch: 'ultimate-chicken-horse',
  ultimatechickenhorse: 'ultimate-chicken-horse',
  'ultimate-chicken': 'ultimate-chicken-horse',
  picopark: 'pico-park',
  pico: 'pico-park',
  boomerangfu: 'boomerang-fu',
  bummerangfu: 'boomerang-fu',
  'bummerang-fu': 'boomerang-fu',
  ibbobb: 'ibb-obb',
  'ibb-and-obb': 'ibb-obb',
  'plate-up': 'plateup',
  'stickfight-the-game': 'stickfight'
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function readSetting(...values) {
  for (const rawValue of values) {
    if (typeof rawValue !== 'string') {
      continue;
    }

    const trimmed = rawValue.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return '';
}

function sanitizeCsvKeys(rawValue) {
  return String(rawValue ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item.length <= 24 && /^[A-Za-z0-9_-]+$/.test(item))
    .filter((item, index, array) => array.indexOf(item) === index);
}

function normalizePresetToken(rawValue) {
  return String(rawValue ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolvePresetName(rawValue) {
  const normalized = normalizePresetToken(rawValue);
  if (!normalized) {
    return '';
  }

  if (LAYOUT_PRESETS[normalized]) {
    return normalized;
  }

  return LAYOUT_PRESET_ALIASES[normalized] ?? '';
}

function sanitizeJoystickMode(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (JOYSTICK_MODES.has(value)) {
    return value;
  }

  return 'dpad';
}

function parsePlayerReservation(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (!value || value === 'auto') {
    return 'auto';
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) {
    console.error(`Invalid player slot count: ${rawValue}`);
    process.exit(1);
  }

  return parsed;
}

function parseHapticsValue(rawValue) {
  const value = String(rawValue ?? 'on').trim().toLowerCase();
  return !(value === 'off' || value === 'false' || value === '0' || value === 'no');
}

function looksLikeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function printLayoutOptions() {
  console.log('Base layouts:');
  for (const [preset, definition] of Object.entries(LAYOUT_PRESETS).filter(([, config]) => config.category === 'base')) {
    console.log(
      `  ${preset.padEnd(8)} joystick=${definition.joystickMode.padEnd(6)} buttons=${definition.buttons.join(',')}  ${definition.description}`
    );
  }
  console.log('');
  console.log('Game profiles:');
  for (const [preset, definition] of Object.entries(LAYOUT_PRESETS).filter(([, config]) => config.category === 'game')) {
    console.log(
      `  ${preset.padEnd(24)} joystick=${definition.joystickMode.padEnd(6)} buttons=${definition.buttons.join(',')}  ${definition.description}`
    );
  }
  console.log('  aliases: "ultimate chicken horse", "pico park", "bummerang fu", "ibb&obb", "plate up", "stickfight the game"');
  console.log('  custom   joystick=dpad|smooth|none  buttons=<csv>');
}

function printLayoutExamples() {
  console.log('Quick setup examples:');
  console.log('  phonepad');
  console.log('  phonepad classic');
  console.log('  phonepad shooter');
  console.log('  phonepad "ultimate chicken horse"');
  console.log('  phonepad "bummerang fu"');
  console.log('  phonepad --preset arcade --haptics off');
  console.log('  phonepad --joystick smooth --buttons A,B,X,Y');
  console.log('  phonepad --joystick none --buttons A,B,START,SELECT');
  console.log('  phonepad driving --players auto');
  console.log('  phonepad driving --players 8');
  console.log('  phonepad --inputs throttle,brake,gearUp,gearDown');
}

function printUsage() {
  console.log('Usage: phonepad [layout|url token] [options]');
  console.log('Options:');
  console.log('  --list-layouts                 Print layout options and exit');
  console.log('  --preset, --layout <name>      Preset/profile name (use --list-layouts)');
  console.log('  --joystick <dpad|smooth|none>  Joystick mode');
  console.log('  --buttons <csv>                Action buttons to show');
  console.log('  --inputs <csv>                 Full custom key list');
  console.log('  --haptics <on|off>             Phone vibration feedback');
  console.log('  --players, --max-players <n|auto>  Reserve local virtual controller slots');
  console.log('  --url <https://...>            Controller base URL override');
  console.log('  --token <secret>               Access token override');
  console.log('  -h, --help                     Print this help');
}

function printSelectedLayout(layoutSummary) {
  const playerLabel =
    layoutSummary.maxPlayers === 'auto' ? 'auto (adaptive pool)' : `${layoutSummary.maxPlayers} reserved slots`;
  console.log('Selected controller setup:');
  console.log(`  preset:   ${layoutSummary.preset}`);
  console.log(`  joystick: ${layoutSummary.joystickMode}`);
  console.log(`  buttons:  ${layoutSummary.buttons.length > 0 ? layoutSummary.buttons.join(',') : '(none)'}`);
  console.log(`  haptics:  ${layoutSummary.haptics ? 'on' : 'off'}`);
  console.log(`  players:  ${playerLabel}`);
  console.log(`  inputs:   ${layoutSummary.inputKeys.join(',')}`);
}

function resolveLayoutConfig({
  presetName,
  joystickValue,
  buttonsValue,
  inputsValue,
  hapticsValue,
  usedJoystickOverride,
  usedButtonsOverride,
  usedInputsOverride,
  usedHapticsOverride
}) {
  const resolvedPresetName = resolvePresetName(presetName);
  if (!resolvedPresetName) {
    console.error(`Unknown preset/layout: ${presetName}`);
    printLayoutOptions();
    process.exit(1);
  }

  const usingCustomOverrides = usedJoystickOverride || usedButtonsOverride || usedInputsOverride || usedHapticsOverride;
  const preset = usingCustomOverrides ? 'custom' : resolvedPresetName;
  const basePreset = LAYOUT_PRESETS[resolvedPresetName];

  const joystickMode = sanitizeJoystickMode(joystickValue || basePreset.joystickMode);

  let buttons = sanitizeCsvKeys(buttonsValue);
  if (buttons.length === 0) {
    buttons = [...basePreset.buttons];
  }

  let inputKeys = sanitizeCsvKeys(inputsValue);
  if (inputKeys.length === 0) {
    inputKeys = [];
    if (joystickMode !== 'none') {
      inputKeys.push(...DIRECTION_KEYS);
    }

    inputKeys.push(...buttons);
    inputKeys = inputKeys.filter((item, index, array) => array.indexOf(item) === index);
  }

  if (inputKeys.length === 0) {
    inputKeys = ['A'];
  }

  if (sanitizeCsvKeys(buttonsValue).length === 0) {
    buttons = inputKeys.filter((key) => !DIRECTION_SET.has(key));
  }

  const haptics = parseHapticsValue(hapticsValue);

  return {
    inputKeys,
    controllerConfig: {
      preset,
      joystickMode,
      buttons,
      haptics
    }
  };
}

function parseArgs(rawArgs, defaults) {
  let showHelp = false;
  let listLayouts = false;
  let presetName = defaults.presetName;
  let joystickValue = defaults.joystickValue;
  let buttonsValue = defaults.buttonsValue;
  let inputsValue = defaults.inputsValue;
  let hapticsValue = defaults.hapticsValue;
  let maxPlayersValue = defaults.maxPlayersValue;
  let baseUrl = defaults.baseUrl;
  let accessToken = defaults.accessToken;

  let usedJoystickOverride = defaults.usedJoystickOverride;
  let usedButtonsOverride = defaults.usedButtonsOverride;
  let usedInputsOverride = defaults.usedInputsOverride;
  let usedHapticsOverride = defaults.usedHapticsOverride;

  let presetExplicitlySet = defaults.presetExplicitlySet;
  const positional = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    if (arg === '--list-layouts') {
      listLayouts = true;
      continue;
    }

    if (arg === '--preset' || arg === '--layout') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }

      presetName = next.trim();
      presetExplicitlySet = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--preset=')) {
      presetName = arg.slice('--preset='.length).trim();
      presetExplicitlySet = true;
      continue;
    }

    if (arg.startsWith('--layout=')) {
      presetName = arg.slice('--layout='.length).trim();
      presetExplicitlySet = true;
      continue;
    }

    if (arg === '--joystick') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --joystick');
        process.exit(1);
      }

      joystickValue = next.trim();
      usedJoystickOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--joystick=')) {
      joystickValue = arg.slice('--joystick='.length).trim();
      usedJoystickOverride = true;
      continue;
    }

    if (arg === '--buttons') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --buttons');
        process.exit(1);
      }

      buttonsValue = next.trim();
      usedButtonsOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--buttons=')) {
      buttonsValue = arg.slice('--buttons='.length).trim();
      usedButtonsOverride = true;
      continue;
    }

    if (arg === '--inputs') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --inputs');
        process.exit(1);
      }

      inputsValue = next.trim();
      usedInputsOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--inputs=')) {
      inputsValue = arg.slice('--inputs='.length).trim();
      usedInputsOverride = true;
      continue;
    }

    if (arg === '--haptics') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --haptics');
        process.exit(1);
      }

      hapticsValue = next.trim();
      usedHapticsOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--haptics=')) {
      hapticsValue = arg.slice('--haptics='.length).trim();
      usedHapticsOverride = true;
      continue;
    }

    if (arg === '--players' || arg === '--max-players') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }

      maxPlayersValue = next.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith('--players=')) {
      maxPlayersValue = arg.slice('--players='.length).trim();
      continue;
    }

    if (arg.startsWith('--max-players=')) {
      maxPlayersValue = arg.slice('--max-players='.length).trim();
      continue;
    }

    if (arg === '--url') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --url');
        process.exit(1);
      }

      baseUrl = next.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith('--url=')) {
      baseUrl = arg.slice('--url='.length).trim();
      continue;
    }

    if (arg === '--token') {
      const next = rawArgs[index + 1];
      if (!next) {
        console.error('Missing value for --token');
        process.exit(1);
      }

      accessToken = next.trim();
      index += 1;
      continue;
    }

    if (arg.startsWith('--token=')) {
      accessToken = arg.slice('--token='.length).trim();
      continue;
    }

    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }

    positional.push(arg);
  }

  if (!presetExplicitlySet && positional.length > 0 && !looksLikeUrl(positional[0])) {
    const maxTokensToCheck = Math.min(positional.length, 6);
    for (let count = maxTokensToCheck; count >= 1; count -= 1) {
      const candidate = positional.slice(0, count).join(' ');
      const resolved = resolvePresetName(candidate);
      if (!resolved) {
        continue;
      }

      presetName = resolved;
      positional.splice(0, count);
      break;
    }
  }

  if (positional.length > 0 && looksLikeUrl(positional[0])) {
    baseUrl = positional.shift().trim();
  }

  if (positional.length > 0) {
    if (!baseUrl) {
      console.error(`Unknown layout or URL: ${positional[0]}`);
      printUsage();
      process.exit(1);
    }

    accessToken = positional.shift().trim();
  }

  if (positional.length > 0) {
    console.error(`Unexpected argument: ${positional[0]}`);
    printUsage();
    process.exit(1);
  }

  return {
    showHelp,
    listLayouts,
    presetName,
    joystickValue,
    buttonsValue,
    inputsValue,
    hapticsValue,
    maxPlayersValue,
    baseUrl,
    accessToken,
    usedJoystickOverride,
    usedButtonsOverride,
    usedInputsOverride,
    usedHapticsOverride
  };
}

function buildControllerUrl(baseUrl, accessToken) {
  const controllerUrl = new URL(baseUrl);
  controllerUrl.search = '';
  if (accessToken) {
    controllerUrl.searchParams.set('token', accessToken);
  }

  return controllerUrl.toString();
}

async function runPhonePadCommand(rawArgs) {
  const fileEnv = loadDotEnv(path.join(__dirname, '.env'));

  const defaults = {
    presetName: readSetting(
      process.env.PHONEPAD_PRESET,
      process.env.PHONEPAD_LAYOUT,
      fileEnv.PHONEPAD_PRESET,
      fileEnv.PHONEPAD_LAYOUT,
      'classic'
    ),
    joystickValue: readSetting(process.env.PHONEPAD_JOYSTICK, fileEnv.PHONEPAD_JOYSTICK),
    buttonsValue: readSetting(process.env.PHONEPAD_BUTTONS, fileEnv.PHONEPAD_BUTTONS),
    inputsValue: readSetting(process.env.PHONEPAD_INPUTS, fileEnv.PHONEPAD_INPUTS),
    hapticsValue: readSetting(process.env.PHONEPAD_HAPTICS, fileEnv.PHONEPAD_HAPTICS, 'on'),
    maxPlayersValue: readSetting(
      process.env.PAD_MAX_PLAYERS,
      process.env.PHONEPAD_MAX_PLAYERS,
      fileEnv.PAD_MAX_PLAYERS,
      fileEnv.PHONEPAD_MAX_PLAYERS,
      'auto'
    ),
    baseUrl: readSetting(process.env.PAD_URL, process.env.PHONEPAD_PUBLIC_URL, fileEnv.PHONEPAD_PUBLIC_URL),
    accessToken: readSetting(process.env.PAD_TOKEN, process.env.PHONEPAD_ACCESS_TOKEN, fileEnv.PHONEPAD_ACCESS_TOKEN),
    usedJoystickOverride: Boolean(readSetting(process.env.PHONEPAD_JOYSTICK, fileEnv.PHONEPAD_JOYSTICK)),
    usedButtonsOverride: Boolean(readSetting(process.env.PHONEPAD_BUTTONS, fileEnv.PHONEPAD_BUTTONS)),
    usedInputsOverride: Boolean(readSetting(process.env.PHONEPAD_INPUTS, fileEnv.PHONEPAD_INPUTS)),
    usedHapticsOverride: Boolean(readSetting(process.env.PHONEPAD_HAPTICS, fileEnv.PHONEPAD_HAPTICS)),
    presetExplicitlySet: Boolean(
      readSetting(process.env.PHONEPAD_PRESET, process.env.PHONEPAD_LAYOUT, fileEnv.PHONEPAD_PRESET, fileEnv.PHONEPAD_LAYOUT)
    )
  };

  const args = [...rawArgs];
  if (args[0] === 'client') {
    args.shift();
  }

  if (args[0] === 'server') {
    console.error('`phonepad server` was removed from the laptop CLI.');
    console.error('Run `node server.js` (or docker compose) on the server host instead.');
    process.exit(1);
  }

  const parsed = parseArgs(args, defaults);

  if (parsed.showHelp) {
    printUsage();
    console.log('');
    printLayoutOptions();
    console.log('');
    printLayoutExamples();
    process.exit(0);
  }

  if (parsed.listLayouts) {
    printLayoutOptions();
    console.log('');
    printLayoutExamples();
    process.exit(0);
  }

  if (!parsed.baseUrl || !parsed.accessToken) {
    console.error('Missing controller URL/token.');
    console.error('Set PHONEPAD_PUBLIC_URL and PHONEPAD_ACCESS_TOKEN in .env, or pass --url and --token.');
    printUsage();
    process.exit(1);
  }

  const layoutConfig = resolveLayoutConfig(parsed);
  const maxPlayers = parsePlayerReservation(parsed.maxPlayersValue);

  let controllerUrl;
  try {
    controllerUrl = buildControllerUrl(parsed.baseUrl, parsed.accessToken);
  } catch {
    console.error(`Invalid base URL: ${parsed.baseUrl}`);
    process.exit(1);
  }

  console.log('PhonePad client running');
  printLayoutOptions();
  console.log('');
  printSelectedLayout({
    preset: layoutConfig.controllerConfig.preset,
    joystickMode: layoutConfig.controllerConfig.joystickMode,
    buttons: layoutConfig.controllerConfig.buttons,
    haptics: layoutConfig.controllerConfig.haptics,
    maxPlayers,
    inputKeys: layoutConfig.inputKeys
  });
  console.log(`Open on phone: ${controllerUrl}`);
  console.log('Tip: refresh the controller page to apply layout changes from a new `phonepad` command.');
  console.log('Press Ctrl+C to stop');
  qrcode.generate(controllerUrl, { small: true });

  const childProcess = spawn(process.execPath, [path.join(__dirname, 'client.js'), parsed.baseUrl, parsed.accessToken], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PAD_LAYOUT_JSON: JSON.stringify({
        inputs: layoutConfig.inputKeys,
        preset: layoutConfig.controllerConfig.preset,
        joystickMode: layoutConfig.controllerConfig.joystickMode,
        buttons: layoutConfig.controllerConfig.buttons,
        haptics: layoutConfig.controllerConfig.haptics
      }),
      PAD_MAX_PLAYERS: String(maxPlayers)
    }
  });

  const forwardSignal = (signal) => {
    if (childProcess.killed) {
      return;
    }

    childProcess.kill(signal);
  };

  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  const { code, signal } = await new Promise((resolve) => {
    childProcess.on('error', (error) => {
      console.error(`Failed to start client: ${error.message}`);
      resolve({ code: 1, signal: null });
    });

    childProcess.on('close', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  if (signal === 'SIGINT' || signal === 'SIGTERM') {
    process.exit(0);
  }

  process.exit(code ?? 0);
}

runPhonePadCommand(process.argv.slice(2));
