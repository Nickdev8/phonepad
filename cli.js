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
    description: 'D-pad + A/B',
    joystickMode: 'dpad',
    buttons: ['A', 'B']
  },
  arcade: {
    description: 'D-pad + A/B/X/Y',
    joystickMode: 'dpad',
    buttons: ['A', 'B', 'X', 'Y']
  },
  shooter: {
    description: 'Smooth stick + A/B/X/Y',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'X', 'Y']
  },
  driving: {
    description: 'Smooth stick + A/B/L1/R1',
    joystickMode: 'smooth',
    buttons: ['A', 'B', 'L1', 'R1']
  },
  minimal: {
    description: 'D-pad + A',
    joystickMode: 'dpad',
    buttons: ['A']
  }
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

function sanitizeJoystickMode(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (JOYSTICK_MODES.has(value)) {
    return value;
  }

  return 'dpad';
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
  console.log('Layout options:');
  for (const [preset, definition] of Object.entries(LAYOUT_PRESETS)) {
    console.log(
      `  ${preset.padEnd(8)} joystick=${definition.joystickMode.padEnd(6)} buttons=${definition.buttons.join(',')}  ${definition.description}`
    );
  }
  console.log('  custom   joystick=dpad|smooth|none  buttons=<csv>');
}

function printLayoutExamples() {
  console.log('Quick setup examples:');
  console.log('  phonepad');
  console.log('  phonepad classic');
  console.log('  phonepad shooter');
  console.log('  phonepad --preset arcade --haptics off');
  console.log('  phonepad --joystick smooth --buttons A,B,X,Y');
  console.log('  phonepad --joystick none --buttons A,B,START,SELECT');
  console.log('  phonepad --inputs throttle,brake,gearUp,gearDown');
}

function printUsage() {
  console.log('Usage: phonepad [layout|url token] [options]');
  console.log('Options:');
  console.log('  --list-layouts                 Print layout options and exit');
  console.log('  --preset, --layout <name>      Preset: classic|arcade|shooter|driving|minimal');
  console.log('  --joystick <dpad|smooth|none>  Joystick mode');
  console.log('  --buttons <csv>                Action buttons to show');
  console.log('  --inputs <csv>                 Full custom key list');
  console.log('  --haptics <on|off>             Phone vibration feedback');
  console.log('  --url <https://...>            Controller base URL override');
  console.log('  --token <secret>               Access token override');
  console.log('  -h, --help                     Print this help');
}

function printSelectedLayout(layoutSummary) {
  console.log('Selected controller setup:');
  console.log(`  preset:   ${layoutSummary.preset}`);
  console.log(`  joystick: ${layoutSummary.joystickMode}`);
  console.log(`  buttons:  ${layoutSummary.buttons.length > 0 ? layoutSummary.buttons.join(',') : '(none)'}`);
  console.log(`  haptics:  ${layoutSummary.haptics ? 'on' : 'off'}`);
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
  if (!LAYOUT_PRESETS[presetName]) {
    console.error(`Unknown preset/layout: ${presetName}`);
    printLayoutOptions();
    process.exit(1);
  }

  const usingCustomOverrides = usedJoystickOverride || usedButtonsOverride || usedInputsOverride || usedHapticsOverride;
  const preset = usingCustomOverrides ? 'custom' : presetName;
  const basePreset = LAYOUT_PRESETS[presetName];

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

      presetName = next.trim().toLowerCase();
      presetExplicitlySet = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--preset=')) {
      presetName = arg.slice('--preset='.length).trim().toLowerCase();
      presetExplicitlySet = true;
      continue;
    }

    if (arg.startsWith('--layout=')) {
      presetName = arg.slice('--layout='.length).trim().toLowerCase();
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

  if (positional.length > 0) {
    const first = positional[0].trim().toLowerCase();
    if (!presetExplicitlySet && LAYOUT_PRESETS[first]) {
      presetName = first;
      positional.shift();
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
    baseUrl,
    accessToken,
    usedJoystickOverride,
    usedButtonsOverride,
    usedInputsOverride,
    usedHapticsOverride
  };
}

function buildControllerUrl(baseUrl, accessToken, layoutConfig) {
  const controllerUrl = new URL(baseUrl);
  if (accessToken) {
    controllerUrl.searchParams.set('token', accessToken);
  }

  controllerUrl.searchParams.set('preset', layoutConfig.controllerConfig.preset);
  controllerUrl.searchParams.set('joystick', layoutConfig.controllerConfig.joystickMode);

  if (layoutConfig.controllerConfig.buttons.length > 0) {
    controllerUrl.searchParams.set('buttons', layoutConfig.controllerConfig.buttons.join(','));
  } else {
    controllerUrl.searchParams.delete('buttons');
  }

  controllerUrl.searchParams.set('inputs', layoutConfig.inputKeys.join(','));
  controllerUrl.searchParams.set('haptics', layoutConfig.controllerConfig.haptics ? 'on' : 'off');

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
    ).toLowerCase(),
    joystickValue: readSetting(process.env.PHONEPAD_JOYSTICK, fileEnv.PHONEPAD_JOYSTICK),
    buttonsValue: readSetting(process.env.PHONEPAD_BUTTONS, fileEnv.PHONEPAD_BUTTONS),
    inputsValue: readSetting(process.env.PHONEPAD_INPUTS, fileEnv.PHONEPAD_INPUTS),
    hapticsValue: readSetting(process.env.PHONEPAD_HAPTICS, fileEnv.PHONEPAD_HAPTICS, 'on'),
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

  let controllerUrl;
  try {
    controllerUrl = buildControllerUrl(parsed.baseUrl, parsed.accessToken, layoutConfig);
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
    inputKeys: layoutConfig.inputKeys
  });
  console.log(`Open on phone: ${controllerUrl}`);
  console.log('Press Ctrl+C to stop');
  qrcode.generate(controllerUrl, { small: true });

  const childProcess = spawn(process.execPath, [path.join(__dirname, 'client.js'), parsed.baseUrl, parsed.accessToken], {
    stdio: 'inherit'
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
