#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { startPhonePadServer } from './server.js';

const DEFAULT_PORT = 3000;
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

function parseServerModeArgs(args) {
  let inputsValue = process.env.PHONEPAD_INPUTS?.trim() || '';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--inputs=')) {
      inputsValue = arg.slice('--inputs='.length).trim();
      continue;
    }

    if (arg === '--inputs') {
      const next = args[index + 1];
      if (!next) {
        console.error('Missing value for --inputs');
        process.exit(1);
      }

      inputsValue = next.trim();
      index += 1;
      continue;
    }

    console.error(`Unknown server argument: ${arg}`);
    console.error('Usage: phonepad server [--inputs up,down,left,right,A,B]');
    process.exit(1);
  }

  return {
    inputKeys: inputsValue
  };
}

async function runServerMode(serverArgs = []) {
  const { inputKeys } = parseServerModeArgs(serverArgs);
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
    runningServer = await startPhonePadServer({ port, host, accessToken, inputKeys });
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
  console.log(`Open on phone: ${controllerUrl}`);
  if (accessToken) {
    console.log('Access token: enabled');
  }
  if (inputKeys) {
    console.log(`Inputs: ${inputKeys}`);
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
