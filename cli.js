#!/usr/bin/env node
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { startPhonePadServer } from './server.js';

const PORT = 3000;

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

async function main() {
  const lanIp = getLanIpAddress();
  const controllerUrl = `http://${lanIp}:${PORT}`;

  let runningServer;
  try {
    runningServer = await startPhonePadServer({ port: PORT });
  } catch (error) {
    console.error(`Failed to start PhonePad: ${error.message}`);
    process.exit(1);
  }

  console.log('PhonePad running');
  console.log(`Open on phone: ${controllerUrl}`);
  qrcode.generate(controllerUrl, { small: true });

  const shutdown = async () => {
    try {
      await runningServer.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
