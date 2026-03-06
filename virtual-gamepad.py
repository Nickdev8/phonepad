#!/usr/bin/env python3
import json
import math
import os
import signal
import sys
from typing import Dict, Iterable, Tuple

from evdev import AbsInfo, UInput, ecodes

AXIS_MAX = 32767
AXIS_DEADZONE = 0.02
MIN_ADAPTIVE_SLOTS = 2
DIRECTION_KEYS = frozenset({"up", "down", "left", "right"})
AXIS_KEYS = frozenset({"axisx", "axisy", "lx", "ly"})
ACTION_BUTTON_CODES = (
    ecodes.BTN_SOUTH,
    ecodes.BTN_EAST,
    ecodes.BTN_NORTH,
    ecodes.BTN_WEST,
    ecodes.BTN_TL,
    ecodes.BTN_TR,
    ecodes.BTN_TL2,
    ecodes.BTN_TR2,
    ecodes.BTN_SELECT,
    ecodes.BTN_START,
    ecodes.BTN_MODE,
    ecodes.BTN_THUMBL,
    ecodes.BTN_THUMBR,
)
PREFERRED_BUTTON_CODES = {
    "A": ecodes.BTN_SOUTH,
    "B": ecodes.BTN_EAST,
    "X": ecodes.BTN_NORTH,
    "Y": ecodes.BTN_WEST,
    "L1": ecodes.BTN_TL,
    "LB": ecodes.BTN_TL,
    "R1": ecodes.BTN_TR,
    "RB": ecodes.BTN_TR,
    "L2": ecodes.BTN_TL2,
    "LT": ecodes.BTN_TL2,
    "R2": ecodes.BTN_TR2,
    "RT": ecodes.BTN_TR2,
    "SELECT": ecodes.BTN_SELECT,
    "BACK": ecodes.BTN_SELECT,
    "START": ecodes.BTN_START,
    "MODE": ecodes.BTN_MODE,
    "HOME": ecodes.BTN_MODE,
    "GUIDE": ecodes.BTN_MODE,
    "L3": ecodes.BTN_THUMBL,
    "R3": ecodes.BTN_THUMBR,
}
BUTTON_CODE_NAMES = {
    ecodes.BTN_SOUTH: "A",
    ecodes.BTN_EAST: "B",
    ecodes.BTN_NORTH: "X",
    ecodes.BTN_WEST: "Y",
    ecodes.BTN_TL: "L1",
    ecodes.BTN_TR: "R1",
    ecodes.BTN_TL2: "L2",
    ecodes.BTN_TR2: "R2",
    ecodes.BTN_SELECT: "SELECT",
    ecodes.BTN_START: "START",
    ecodes.BTN_MODE: "MODE",
    ecodes.BTN_THUMBL: "L3",
    ecodes.BTN_THUMBR: "R3",
}
EMPTY_DPAD_STATE = {
    "up": False,
    "down": False,
    "left": False,
    "right": False,
    "axisX": 0.0,
    "axisY": 0.0,
}
active_button_layout: Tuple[str, ...] = ()
active_button_map: Dict[str, int] = {}
active_dropped_buttons: Tuple[str, ...] = ()


def clamp_axis(raw_value):
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(value):
        return None

    if value > 1:
        value = 1.0
    elif value < -1:
        value = -1.0

    if abs(value) < AXIS_DEADZONE:
        return 0.0

    return value


def normalize_action_key(raw_key):
    return str(raw_key or "").strip().upper().replace("-", "").replace("_", "")


def iter_action_keys(raw_state: Dict[str, object]) -> Iterable[str]:
    for raw_key in raw_state.keys():
        key = str(raw_key or "").strip()
        if not key:
            continue

        normalized = key.lower()
        if normalized in DIRECTION_KEYS or normalized in AXIS_KEYS:
            continue

        yield key


def build_button_map(button_keys: Iterable[str]) -> Tuple[Dict[str, int], Tuple[str, ...]]:
    mapping: Dict[str, int] = {}
    used_codes = set()
    remaining_keys = []

    for key in button_keys:
        preferred_code = PREFERRED_BUTTON_CODES.get(normalize_action_key(key))
        if preferred_code is None or preferred_code in used_codes:
            remaining_keys.append(key)
            continue

        mapping[key] = preferred_code
        used_codes.add(preferred_code)

    for key in remaining_keys:
        next_code = next((code for code in ACTION_BUTTON_CODES if code not in used_codes), None)
        if next_code is None:
            continue

        mapping[key] = next_code
        used_codes.add(next_code)

    dropped = tuple(key for key in button_keys if key not in mapping)
    return mapping, dropped


def ensure_button_map(raw_state: Dict[str, object]) -> Dict[str, int]:
    global active_button_layout
    global active_button_map
    global active_dropped_buttons

    button_keys = tuple(iter_action_keys(raw_state))
    if button_keys == active_button_layout:
        return active_button_map

    active_button_layout = button_keys
    active_button_map, dropped = build_button_map(button_keys)

    if active_button_map:
        assignments = ", ".join(
            f"{key}->{BUTTON_CODE_NAMES.get(code, str(code))}"
            for key, code in active_button_map.items()
        )
        print(f"updated virtual button map: {assignments}", file=sys.stderr, flush=True)

    if dropped and dropped != active_dropped_buttons:
        print(
            "warning: too many action buttons for one virtual pad; ignoring "
            + ",".join(dropped),
            file=sys.stderr,
            flush=True,
        )

    active_dropped_buttons = dropped
    return active_button_map


def normalize_state(raw, button_keys):
    raw = raw if isinstance(raw, dict) else {}
    up = bool(raw.get("up", False))
    down = bool(raw.get("down", False))
    left = bool(raw.get("left", False))
    right = bool(raw.get("right", False))
    axis_x = clamp_axis(raw.get("axisX", raw.get("lx")))
    axis_y = clamp_axis(raw.get("axisY", raw.get("ly")))

    if axis_x is None:
        axis_x = signed_axis(left, right, 1.0)

    if axis_y is None:
        axis_y = signed_axis(up, down, 1.0)

    return {
        "up": up,
        "down": down,
        "left": left,
        "right": right,
        "axisX": axis_x,
        "axisY": axis_y,
        "buttons": {key: bool(raw.get(key, False)) for key in button_keys},
    }


def signed_axis(negative_pressed, positive_pressed, max_value):
    if negative_pressed and not positive_pressed:
        return -max_value
    if positive_pressed and not negative_pressed:
        return max_value
    return 0


class VirtualPad:
    def __init__(self, slot_id):
        capabilities = {
            ecodes.EV_KEY: [
                *ACTION_BUTTON_CODES,
                ecodes.BTN_DPAD_UP,
                ecodes.BTN_DPAD_DOWN,
                ecodes.BTN_DPAD_LEFT,
                ecodes.BTN_DPAD_RIGHT,
            ],
            ecodes.EV_ABS: [
                (ecodes.ABS_X, AbsInfo(0, -AXIS_MAX, AXIS_MAX, 16, 128, 0)),
                (ecodes.ABS_Y, AbsInfo(0, -AXIS_MAX, AXIS_MAX, 16, 128, 0)),
                (ecodes.ABS_HAT0X, AbsInfo(0, -1, 1, 0, 0, 0)),
                (ecodes.ABS_HAT0Y, AbsInfo(0, -1, 1, 0, 0, 0)),
            ],
        }

        self.slot_id = int(slot_id)
        self.dpad_state = dict(EMPTY_DPAD_STATE)
        self.button_states = {code: False for code in ACTION_BUTTON_CODES}
        self.axis_x = 0
        self.axis_y = 0
        self.hat_x = 0
        self.hat_y = 0
        self.device = UInput(
            capabilities,
            name=f"PhonePad Slot {self.slot_id}",
            vendor=0x1209,
            product=0x5050,
            version=1,
            phys=f"phonepad/slot-{self.slot_id}",
        )
        print(
            f"created virtual controller slot {self.slot_id}",
            file=sys.stderr,
            flush=True,
        )

    def _write_button(self, code, pressed):
        self.device.write(ecodes.EV_KEY, code, 1 if pressed else 0)

    def apply_state(self, raw_state):
        button_map = ensure_button_map(raw_state)
        next_state = normalize_state(raw_state, button_map.keys())
        changed = False

        for key, code in (
            ("up", ecodes.BTN_DPAD_UP),
            ("down", ecodes.BTN_DPAD_DOWN),
            ("left", ecodes.BTN_DPAD_LEFT),
            ("right", ecodes.BTN_DPAD_RIGHT),
        ):
            if self.dpad_state[key] != next_state[key]:
                self._write_button(code, next_state[key])
                self.dpad_state[key] = next_state[key]
                changed = True

        next_button_states = {code: False for code in ACTION_BUTTON_CODES}
        for key, pressed in next_state["buttons"].items():
            mapped_code = button_map.get(key)
            if mapped_code is None:
                continue

            next_button_states[mapped_code] = pressed

        for code in ACTION_BUTTON_CODES:
            if self.button_states[code] == next_button_states[code]:
                continue

            self._write_button(code, next_button_states[code])
            self.button_states[code] = next_button_states[code]
            changed = True

        new_axis_x = int(round(next_state["axisX"] * AXIS_MAX))
        new_axis_y = int(round(next_state["axisY"] * AXIS_MAX))
        new_hat_x = signed_axis(next_state["left"], next_state["right"], 1)
        new_hat_y = signed_axis(next_state["up"], next_state["down"], 1)

        if new_axis_x != self.axis_x:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_X, new_axis_x)
            self.axis_x = new_axis_x
            changed = True

        if new_axis_y != self.axis_y:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_Y, new_axis_y)
            self.axis_y = new_axis_y
            changed = True

        if new_hat_x != self.hat_x:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_HAT0X, new_hat_x)
            self.hat_x = new_hat_x
            changed = True

        if new_hat_y != self.hat_y:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_HAT0Y, new_hat_y)
            self.hat_y = new_hat_y
            changed = True

        if changed:
            self.device.syn()

        self.dpad_state["up"] = next_state["up"]
        self.dpad_state["down"] = next_state["down"]
        self.dpad_state["left"] = next_state["left"]
        self.dpad_state["right"] = next_state["right"]
        self.dpad_state["axisX"] = next_state["axisX"]
        self.dpad_state["axisY"] = next_state["axisY"]

    def reset(self):
        changed = False

        for code, pressed in self.button_states.items():
            if not pressed:
                continue

            self._write_button(code, False)
            self.button_states[code] = False
            changed = True

        for key, code in (
            ("up", ecodes.BTN_DPAD_UP),
            ("down", ecodes.BTN_DPAD_DOWN),
            ("left", ecodes.BTN_DPAD_LEFT),
            ("right", ecodes.BTN_DPAD_RIGHT),
        ):
            if not self.dpad_state[key]:
                continue

            self._write_button(code, False)
            self.dpad_state[key] = False
            changed = True

        if self.axis_x != 0:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_X, 0)
            self.axis_x = 0
            changed = True

        if self.axis_y != 0:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_Y, 0)
            self.axis_y = 0
            changed = True

        if self.hat_x != 0:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_HAT0X, 0)
            self.hat_x = 0
            changed = True

        if self.hat_y != 0:
            self.device.write(ecodes.EV_ABS, ecodes.ABS_HAT0Y, 0)
            self.hat_y = 0
            changed = True

        self.dpad_state["axisX"] = 0.0
        self.dpad_state["axisY"] = 0.0

        if changed:
            self.device.syn()

    def close(self):
        self.reset()
        self.device.close()


pads: Dict[int, VirtualPad] = {}
player_to_slot: Dict[str, int] = {}
fixed_reserved_slots = None


def parse_reserved_slots():
    raw_value = (
        os.environ.get("PAD_MAX_PLAYERS")
        or os.environ.get("PHONEPAD_MAX_PLAYERS")
        or ""
    ).strip()
    if not raw_value:
        return None

    normalized = raw_value.lower()
    if normalized == "auto":
        return None

    try:
        parsed = int(raw_value)
    except ValueError:
        print(
            "invalid PAD_MAX_PLAYERS value "
            f"`{raw_value}`, defaulting to adaptive mode",
            file=sys.stderr,
            flush=True,
        )
        return None

    return max(1, parsed)


def next_auto_reservation_target(active_player_count):
    target = MIN_ADAPTIVE_SLOTS
    while target < active_player_count:
        target *= 2

    return target


def ensure_pad(slot_id):
    normalized_slot = int(slot_id)
    pad = pads.get(normalized_slot)
    if pad is not None:
        return pad

    try:
        pad = VirtualPad(normalized_slot)
    except OSError as error:
        print(
            f"failed to create virtual gamepad (slot {normalized_slot}): {error}",
            file=sys.stderr,
        )
        print(
            "make sure uinput is available (sudo modprobe uinput) and your user can access /dev/uinput",
            file=sys.stderr,
        )
        raise

    pads[normalized_slot] = pad
    return pad


def assign_slot(player_id):
    normalized_player = str(player_id)
    assigned_slot = player_to_slot.get(normalized_player)
    if assigned_slot is not None:
        return assigned_slot

    reserve_slots_for_player_count(len(player_to_slot) + 1)
    used_slots = set(player_to_slot.values())
    next_slot = 1
    while next_slot in used_slots:
        next_slot += 1

    ensure_pad(next_slot)
    player_to_slot[normalized_player] = next_slot
    print(
        f"assigned player {normalized_player} to virtual controller slot {next_slot}",
        file=sys.stderr,
        flush=True,
    )
    return next_slot


def release_player(player_id):
    normalized_player = str(player_id)
    assigned_slot = player_to_slot.pop(normalized_player, None)
    if assigned_slot is None:
        return

    pad = pads.get(assigned_slot)
    if pad is None:
        return

    pad.reset()
    print(
        f"released player {normalized_player} from virtual controller slot {assigned_slot}",
        file=sys.stderr,
        flush=True,
    )


def reset_pad(player_id):
    normalized_player = str(player_id)
    assigned_slot = player_to_slot.get(normalized_player)
    if assigned_slot is None:
        return

    pad = pads.get(assigned_slot)
    if pad is None:
        return

    pad.reset()


def apply_state(player_id, state):
    slot_id = assign_slot(player_id)
    ensure_pad(slot_id).apply_state(state if isinstance(state, dict) else {})


def sync_players(player_ids):
    active_players = {str(player_id) for player_id in player_ids}
    for player_id in tuple(player_to_slot):
        if player_id in active_players:
            continue

        release_player(player_id)


def preallocate_slots(slot_count):
    created = 0
    existing_count = len(pads)
    for slot_id in range(slot_count, existing_count, -1):
        try:
            ensure_pad(slot_id)
        except OSError:
            if created == 0:
                raise

            print(
                f"reserved {existing_count + created} virtual controller slots before hitting a system limit",
                file=sys.stderr,
                flush=True,
            )
            return
        created += 1

    if created > 0:
        print(
            f"reserved {existing_count + created} virtual controller slots",
            file=sys.stderr,
            flush=True,
        )


def reserve_slots_for_player_count(active_player_count):
    if fixed_reserved_slots is not None:
        return

    target_slot_count = next_auto_reservation_target(active_player_count)
    if len(pads) >= target_slot_count:
        return

    preallocate_slots(target_slot_count)


def shutdown(*_args):
    for pad in list(pads.values()):
        pad.close()
    pads.clear()
    raise SystemExit(0)


signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

fixed_reserved_slots = parse_reserved_slots()
if fixed_reserved_slots is not None:
    preallocate_slots(fixed_reserved_slots)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        message = json.loads(line)
    except json.JSONDecodeError:
        continue

    message_type = message.get("type")
    if message_type == "state":
        player_id = message.get("playerId")
        state = message.get("state", {})
        if player_id is None:
            continue
        apply_state(player_id, state)
        continue

    if message_type == "remove_player":
        player_id = message.get("playerId")
        if player_id is None:
            continue
        release_player(player_id)
        continue

    if message_type == "reset_player":
        player_id = message.get("playerId")
        if player_id is None:
            continue
        reset_pad(player_id)
        continue

    if message_type == "sync_players":
        player_ids = message.get("playerIds")
        if not isinstance(player_ids, list):
            continue
        sync_players(player_ids)
