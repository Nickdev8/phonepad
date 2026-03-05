#!/usr/bin/env python3
import json
import math
import signal
import sys
from typing import Dict

from evdev import AbsInfo, UInput, ecodes

AXIS_MAX = 32767
AXIS_DEADZONE = 0.02
EMPTY_STATE = {
    "up": False,
    "down": False,
    "left": False,
    "right": False,
    "A": False,
    "B": False,
    "axisX": 0.0,
    "axisY": 0.0,
}


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


def normalize_state(raw):
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
        "A": bool(raw.get("A", False)),
        "B": bool(raw.get("B", False)),
        "axisX": axis_x,
        "axisY": axis_y,
    }


def signed_axis(negative_pressed, positive_pressed, max_value):
    if negative_pressed and not positive_pressed:
        return -max_value
    if positive_pressed and not negative_pressed:
        return max_value
    return 0


class VirtualPad:
    def __init__(self, player_id):
        capabilities = {
            ecodes.EV_KEY: [
                ecodes.BTN_SOUTH,
                ecodes.BTN_EAST,
                ecodes.BTN_NORTH,
                ecodes.BTN_WEST,
                ecodes.BTN_START,
                ecodes.BTN_SELECT,
                ecodes.BTN_MODE,
                ecodes.BTN_TL,
                ecodes.BTN_TR,
                ecodes.BTN_THUMBL,
                ecodes.BTN_THUMBR,
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

        self.player_id = str(player_id)
        self.state = dict(EMPTY_STATE)
        self.axis_x = 0
        self.axis_y = 0
        self.hat_x = 0
        self.hat_y = 0
        self.device = UInput(
            capabilities,
            name=f"PhonePad Player {self.player_id}",
            vendor=0x1209,
            product=0x5050,
            version=1,
        )
        print(
            f"created virtual controller for player {self.player_id}: {self.device.devnode}",
            file=sys.stderr,
            flush=True,
        )

    def _write_button(self, code, pressed):
        self.device.write(ecodes.EV_KEY, code, 1 if pressed else 0)

    def apply_state(self, next_state):
        next_state = normalize_state(next_state)
        changed = False

        for key, code in (
            ("A", ecodes.BTN_SOUTH),
            ("B", ecodes.BTN_EAST),
            ("up", ecodes.BTN_DPAD_UP),
            ("down", ecodes.BTN_DPAD_DOWN),
            ("left", ecodes.BTN_DPAD_LEFT),
            ("right", ecodes.BTN_DPAD_RIGHT),
        ):
            if self.state[key] != next_state[key]:
                self._write_button(code, next_state[key])
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

        self.state = next_state

    def close(self):
        self.apply_state(EMPTY_STATE)
        self.device.close()


pads: Dict[str, VirtualPad] = {}


def ensure_pad(player_id):
    normalized_player = str(player_id)
    pad = pads.get(normalized_player)
    if pad is not None:
        return pad

    try:
        pad = VirtualPad(normalized_player)
    except OSError as error:
        print(
            f"failed to create virtual gamepad (player {normalized_player}): {error}",
            file=sys.stderr,
        )
        print(
            "make sure uinput is available (sudo modprobe uinput) and your user can access /dev/uinput",
            file=sys.stderr,
        )
        raise

    pads[normalized_player] = pad
    return pad


def remove_pad(player_id):
    normalized_player = str(player_id)
    pad = pads.pop(normalized_player, None)
    if pad is None:
        return

    pad.close()
    print(
        f"removed virtual controller for player {normalized_player}",
        file=sys.stderr,
        flush=True,
    )


def reset_pad(player_id):
    normalized_player = str(player_id)
    pad = pads.get(normalized_player)
    if pad is None:
        return

    pad.apply_state(EMPTY_STATE)


def shutdown(*_args):
    for pad in list(pads.values()):
        pad.close()
    pads.clear()
    raise SystemExit(0)


signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

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
        ensure_pad(player_id).apply_state(state)
        continue

    if message_type == "remove_player":
        player_id = message.get("playerId")
        if player_id is None:
            continue
        remove_pad(player_id)
        continue

    if message_type == "reset_player":
        player_id = message.get("playerId")
        if player_id is None:
            continue
        reset_pad(player_id)
