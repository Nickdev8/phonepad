#!/usr/bin/env node
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { startPhonePadServer } from './server.js';

const DEFAULT_PORT = 3000;

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

async function main() {
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
    runningServer = await startPhonePadServer({ port, host, accessToken });
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

main();
