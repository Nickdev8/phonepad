#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { startPhonePadServer } from './server.js';

const DEFAULT_PORT = 3000;
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

function isPrivateIPv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  if (parts[0] === 10) {
    return true;
  }

  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }

  return parts[0] === 192 && parts[1] === 168;
}

function getLanIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    const allCandidates = [];

    for (const records of Object.values(interfaces)) {
      if (!records) {
        continue;
      }

      for (const details of records) {
        if (details.family !== 'IPv4' || details.internal) {
          continue;
        }

        allCandidates.push(details.address);
        if (isPrivateIPv4(details.address)) {
          return details.address;
        }
      }
    }

    return allCandidates[0] ?? '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

function buildControllerUrl(baseUrl, accessToken) {
  const controllerUrl = new URL(baseUrl);
  if (accessToken) {
    controllerUrl.searchParams.set('token', accessToken);
  }

  return controllerUrl.toString();
}

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
  console.log('  phonepad server --preset classic');
  console.log('  phonepad server --preset shooter');
  console.log('  phonepad server --preset arcade --haptics off');
  console.log('  phonepad server --joystick smooth --buttons A,B,X,Y');
  console.log('  phonepad server --joystick none --buttons A,B,START,SELECT');
  console.log('  phonepad server --inputs throttle,brake,gearUp,gearDown');
}

function printServerUsage() {
  console.log('Usage: phonepad server [options]');
  console.log('Options:');
  console.log('  --preset, --layout <name>      Preset: classic|arcade|shooter|driving|minimal');
  console.log('  --joystick <dpad|smooth|none>  Joystick mode');
  console.log('  --buttons <csv>                Action buttons to show');
  console.log('  --inputs <csv>                 Full custom key list');
  console.log('  --haptics <on|off>             Phone vibration feedback');
  console.log('  --list-layouts                 Print presets and exit');
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

function parseServerModeArgs(args) {
  let listLayouts = false;
  let showHelp = false;
  let presetName = (process.env.PHONEPAD_PRESET || process.env.PHONEPAD_LAYOUT || 'classic').trim().toLowerCase();
  let joystickValue = process.env.PHONEPAD_JOYSTICK?.trim() || '';
  let buttonsValue = process.env.PHONEPAD_BUTTONS?.trim() || '';
  let inputsValue = process.env.PHONEPAD_INPUTS?.trim() || '';
  let hapticsValue = process.env.PHONEPAD_HAPTICS?.trim() || 'on';
  let usedJoystickOverride = Boolean(process.env.PHONEPAD_JOYSTICK?.trim());
  let usedButtonsOverride = Boolean(process.env.PHONEPAD_BUTTONS?.trim());
  let usedInputsOverride = Boolean(process.env.PHONEPAD_INPUTS?.trim());
  let usedHapticsOverride = Boolean(process.env.PHONEPAD_HAPTICS?.trim());

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }

    if (arg === '--list-layouts') {
      listLayouts = true;
      continue;
    }

    if (arg.startsWith('--preset=')) {
      presetName = arg.slice('--preset='.length).trim().toLowerCase();
      continue;
    }

    if (arg === '--preset') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --preset');
        process.exit(1);
      }

      presetName = next.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith('--layout=')) {
      presetName = arg.slice('--layout='.length).trim().toLowerCase();
      continue;
    }

    if (arg === '--layout') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --layout');
        process.exit(1);
      }

      presetName = next.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith('--joystick=')) {
      joystickValue = arg.slice('--joystick='.length).trim();
      usedJoystickOverride = true;
      continue;
    }

    if (arg === '--joystick') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --joystick');
        process.exit(1);
      }

      joystickValue = next.trim();
      usedJoystickOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--buttons=')) {
      buttonsValue = arg.slice('--buttons='.length).trim();
      usedButtonsOverride = true;
      continue;
    }

    if (arg === '--buttons') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --buttons');
        process.exit(1);
      }

      buttonsValue = next.trim();
      usedButtonsOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--inputs=')) {
      inputsValue = arg.slice('--inputs='.length).trim();
      usedInputsOverride = true;
      continue;
    }

    if (arg === '--inputs') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --inputs');
        process.exit(1);
      }

      inputsValue = next.trim();
      usedInputsOverride = true;
      index += 1;
      continue;
    }

    if (arg.startsWith('--haptics=')) {
      hapticsValue = arg.slice('--haptics='.length).trim();
      usedHapticsOverride = true;
      continue;
    }

    if (arg === '--haptics') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --haptics');
        process.exit(1);
      }

      hapticsValue = next.trim();
      usedHapticsOverride = true;
      index += 1;
      continue;
    }

    console.error(`Unknown server argument: ${arg}`);
    printServerUsage();
    process.exit(1);
  }

  if (showHelp) {
    printServerUsage();
    console.log('');
    printLayoutOptions();
    console.log('');
    printLayoutExamples();
    process.exit(0);
  }

  if (listLayouts) {
    printLayoutOptions();
    console.log('');
    printLayoutExamples();
    process.exit(0);
  }

  if (!presetName) {
    presetName = 'classic';
  }

  if (!LAYOUT_PRESETS[presetName]) {
    console.error(`Unknown preset/layout: ${presetName}`);
    printLayoutOptions();
    process.exit(1);
  }

  const usingCustomOverrides = usedJoystickOverride || usedButtonsOverride || usedInputsOverride || usedHapticsOverride;
  const preset = usingCustomOverrides ? 'custom' : presetName;
  const basePresetDefinition = LAYOUT_PRESETS[presetName];
  const joystickMode = sanitizeJoystickMode(joystickValue || basePresetDefinition.joystickMode);
  let buttons = sanitizeCsvKeys(buttonsValue);
  if (buttons.length === 0) {
    buttons = [...basePresetDefinition.buttons];
  }

  let inputKeys = sanitizeCsvKeys(inputsValue);
  if (inputKeys.length === 0) {
    inputKeys = [];
    if (joystickMode !== 'none') {
      inputKeys.push(...DIRECTION_KEYS);
    }
    inputKeys.push(...buttons);
    inputKeys = inputKeys.filter((item, itemIndex, array) => array.indexOf(item) === itemIndex);
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

async function runServerMode(serverArgs = []) {
  const { inputKeys, controllerConfig } = parseServerModeArgs(serverArgs);
  const configuredPort = Number.parseInt(process.env.PHONEPAD_PORT ?? `${DEFAULT_PORT}`, 10);
  const port = Number.isFinite(configuredPort) ? configuredPort : DEFAULT_PORT;
  const host = process.env.PHONEPAD_HOST?.trim() || '0.0.0.0';
  const publicUrl = process.env.PHONEPAD_PUBLIC_URL?.trim() || '';
  const accessToken = process.env.PHONEPAD_ACCESS_TOKEN?.trim() || '';

  if (publicUrl && !accessToken) {
    console.error('PHONEPAD_ACCESS_TOKEN is required when PHONEPAD_PUBLIC_URL is set.');
    process.exit(1);
  }

  const lanIp = getLanIpAddress();
  const fallbackUrl = `http://${lanIp}:${port}`;
  const baseUrl = publicUrl || fallbackUrl;
  let controllerUrl;
  try {
    controllerUrl = buildControllerUrl(baseUrl, accessToken);
  } catch {
    console.error(`Invalid URL in PHONEPAD_PUBLIC_URL: ${publicUrl}`);
    process.exit(1);
  }

  let runningServer;
  try {
    runningServer = await startPhonePadServer({ port, host, accessToken, inputKeys, controllerConfig });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the old process or choose a different PHONEPAD_PORT.`);
      console.error(`Try: lsof -i :${port}`);
      process.exit(1);
    }

    console.error(`Failed to start PhonePad: ${error.message}`);
    process.exit(1);
  }

  console.log('PhonePad running');
  printServerUsage();
  console.log('');
  printLayoutOptions();
  console.log('');
  printLayoutExamples();
  console.log('');
  printSelectedLayout({
    preset: controllerConfig.preset,
    joystickMode: controllerConfig.joystickMode,
    buttons: controllerConfig.buttons,
    haptics: controllerConfig.haptics,
    inputKeys
  });
  console.log(`Open on phone: ${controllerUrl}`);
  if (accessToken) {
    console.log('Access token: enabled');
  }

  qrcode.generate(controllerUrl, { small: true });

  const shutdown = async () => {
    try {
      await runningServer.stop();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runClientMode(clientArgs) {
  const fileEnv = loadDotEnv(path.join(__dirname, '.env'));
  const baseUrl =
    clientArgs[0]?.trim() ||
    process.env.PAD_URL?.trim() ||
    process.env.PHONEPAD_PUBLIC_URL?.trim() ||
    fileEnv.PHONEPAD_PUBLIC_URL ||
    '';
  const accessToken =
    clientArgs[1]?.trim() ||
    process.env.PAD_TOKEN?.trim() ||
    process.env.PHONEPAD_ACCESS_TOKEN?.trim() ||
    fileEnv.PHONEPAD_ACCESS_TOKEN ||
    '';

  if (!baseUrl || !accessToken) {
    console.error('Usage: phonepad [base_url] [token]');
    console.error('   or: phonepad client <base_url> <token>');
    console.error('Or set PAD_URL/PAD_TOKEN or PHONEPAD_PUBLIC_URL/PHONEPAD_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  let controllerUrl;
  try {
    controllerUrl = buildControllerUrl(baseUrl, accessToken);
  } catch {
    console.error(`Invalid base URL: ${baseUrl}`);
    process.exit(1);
  }

  console.log('PhonePad client running');
  console.log('Server layout options: run `phonepad server --list-layouts` on the host server.');
  console.log(`Open on phone: ${controllerUrl}`);
  console.log('Press Ctrl+C to stop');
  qrcode.generate(controllerUrl, { small: true });

  const childProcess = spawn(process.execPath, [path.join(__dirname, 'client.js'), baseUrl, accessToken], {
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

async function main() {
  const [mode, ...modeArgs] = process.argv.slice(2);
  if (!mode) {
    await runClientMode([]);
    return;
  }

  if (mode === 'server') {
    await runServerMode(modeArgs);
    return;
  }

  if (mode === 'client') {
    await runClientMode(modeArgs);
    return;
  }

  await runClientMode([mode, ...modeArgs]);
}

main();
