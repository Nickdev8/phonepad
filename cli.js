#!/usr/bin/env node

export * from './bin/phonepad.js';
import { runPhonePadCommand } from './bin/phonepad.js';

await runPhonePadCommand(process.argv.slice(2));
