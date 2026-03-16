import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUTO_RESERVED_SLOTS,
  describePlayerReservation,
  isDirectCliInvocation,
  loadOrCreateControllerSessionToken,
  parseArgs,
  parsePlayerReservation,
  resolveLayoutConfig,
  resolveMaxPlayersValueForPreset
} from '../bin/phonepad.js';

const DEFAULT_PARSE_ARGS_OPTIONS = Object.freeze({
  debug: false,
  presetName: 'classic',
  joystickValue: '',
  buttonsValue: '',
  inputsValue: '',
  hapticsValue: 'on',
  maxPlayersValue: 'adaptive',
  baseUrl: 'https://example.com',
  accessToken: 'secret',
  usedJoystickOverride: false,
  usedButtonsOverride: false,
  usedInputsOverride: false,
  usedHapticsOverride: false,
  usedMaxPlayersOverride: false,
  presetExplicitlySet: false
});
const CLI_FILENAME = fileURLToPath(new URL('../bin/phonepad.js', import.meta.url));

test('parsePlayerReservation defaults to adaptive mode', () => {
  assert.deepEqual(parsePlayerReservation(''), {
    mode: 'adaptive',
    reservedSlots: 0
  });
  assert.deepEqual(parsePlayerReservation('auto'), {
    mode: 'auto',
    reservedSlots: DEFAULT_AUTO_RESERVED_SLOTS
  });
});

test('parsePlayerReservation supports adaptive and fixed modes', () => {
  assert.deepEqual(parsePlayerReservation('adaptive'), {
    mode: 'adaptive',
    reservedSlots: 0
  });
  assert.deepEqual(parsePlayerReservation('8'), {
    mode: 'fixed',
    reservedSlots: 8
  });
});

test('describePlayerReservation reflects the new mode semantics', () => {
  assert.equal(
    describePlayerReservation({ mode: 'adaptive', reservedSlots: 0 }),
    'adaptive (matches connected players, expands as needed)'
  );
  assert.equal(
    describePlayerReservation({ mode: 'auto', reservedSlots: DEFAULT_AUTO_RESERVED_SLOTS }),
    `auto (${DEFAULT_AUTO_RESERVED_SLOTS}-slot stable pool, expands as needed)`
  );
  assert.equal(
    describePlayerReservation({ mode: 'fixed', reservedSlots: 6 }),
    '6 reserved slots'
  );
});

test('parseArgs accepts -d and adaptive player mode', () => {
  const parsed = parseArgs(
    ['ultimate-chicken-horse', '-d', '--players', 'adaptive'],
    DEFAULT_PARSE_ARGS_OPTIONS
  );

  assert.equal(parsed.presetName, 'ultimate-chicken-horse');
  assert.equal(parsed.debug, true);
  assert.equal(parsed.maxPlayersValue, 'adaptive');
});

test('Ultimate Chicken Horse defaults to adaptive virtual pad allocation', () => {
  const parsed = parseArgs(
    ['ultimate-chicken-horse'],
    DEFAULT_PARSE_ARGS_OPTIONS
  );

  assert.equal(
    resolveMaxPlayersValueForPreset(parsed),
    'adaptive'
  );
});

test('Ultimate Chicken Horse includes rotate triggers by default', () => {
  const layout = resolveLayoutConfig({
    presetName: 'ultimate-chicken-horse',
    joystickValue: '',
    buttonsValue: '',
    inputsValue: '',
    hapticsValue: 'on',
    usedJoystickOverride: false,
    usedButtonsOverride: false,
    usedInputsOverride: false,
    usedHapticsOverride: false
  });

  assert.deepEqual(layout.controllerConfig.buttons, ['A', 'B', 'X', 'Y', 'L1', 'R1']);
  assert.deepEqual(layout.inputKeys, ['up', 'down', 'left', 'right', 'A', 'B', 'X', 'Y', 'L1', 'R1']);
});

test('explicit player reservation still overrides the preset default', () => {
  const parsed = parseArgs(
    ['ultimate-chicken-horse', '--players', '8'],
    DEFAULT_PARSE_ARGS_OPTIONS
  );

  assert.equal(
    resolveMaxPlayersValueForPreset(parsed),
    '8'
  );
});

test('isDirectCliInvocation resolves symlinked bin paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonepad-cli-'));
  const symlinkPath = path.join(tempDir, 'phonepad');

  try {
    fs.symlinkSync(CLI_FILENAME, symlinkPath);
    assert.equal(isDirectCliInvocation(symlinkPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadOrCreateControllerSessionToken reuses the same token within one boot marker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonepad-session-'));
  const statePath = path.join(tempDir, 'controller-session.json');

  try {
    const firstToken = loadOrCreateControllerSessionToken({
      statePath,
      bootMarker: 'boot-a'
    });
    const secondToken = loadOrCreateControllerSessionToken({
      statePath,
      bootMarker: 'boot-a'
    });

    assert.match(firstToken, /^[a-f0-9]{64}$/);
    assert.equal(secondToken, firstToken);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadOrCreateControllerSessionToken rotates when the boot marker changes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonepad-session-'));
  const statePath = path.join(tempDir, 'controller-session.json');

  try {
    const firstToken = loadOrCreateControllerSessionToken({
      statePath,
      bootMarker: 'boot-a'
    });
    const secondToken = loadOrCreateControllerSessionToken({
      statePath,
      bootMarker: 'boot-b'
    });

    assert.notEqual(secondToken, firstToken);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
