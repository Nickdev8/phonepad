# PhonePad

Minimal smartphone controller over WebSockets.

## Local run

```bash
npm install
node server.js
```

## Public run (server/subdomain)

1. Copy `.env.example` to `.env`.
2. Set:
   - `PHONEPAD_PUBLIC_URL` to your public HTTPS URL (for example `https://phonepad.nickesselman.nl`)
   - `PHONEPAD_ACCESS_TOKEN` to a long random admin secret kept on the laptop/server side
3. Start:

```bash
docker compose up -d --build
```

Open the controller URL printed by the laptop client:

```bash
phonepad
```

That phone URL includes a controller session token. It is different from `PHONEPAD_ACCESS_TOKEN`, and it rotates once per laptop boot/login session instead of on every `phonepad` run.

## Reverse proxy / tunnel requirement

Point your subdomain (or tunnel) to this container's `3017` port and keep WebSocket upgrade support enabled.

## Phone UI

The page supports both portrait and landscape with no scrolling, and keeps the controller token for the current browser tab session so refreshes of the same tab keep working.
In landscape, the header collapses away so the controls take the screen unless reconnect is needed.
Safari does not expose the web vibration API here. On supported Apple versions, PhonePad uses Safari's native HTML `switch` haptic path; older versions still fall back to visual press feedback.

## Layout setup command

The laptop command controls the visible controls, and pushes layout to the server at runtime.
When you run `phonepad` with a new layout, just refresh the phone page to apply it (no rescan needed).

List all layouts:

```bash
phonepad --list-layouts
```

Preset layouts:

```bash
phonepad arcade
phonepad shooter
phonepad --preset minimal
```

Game profiles:

```bash
phonepad ultimate-chicken-horse
phonepad pico-park
phonepad boomerang-fu
phonepad ibb-obb
phonepad plateup
phonepad unrailed
phonepad stickfight
```

You can also use aliases like `phonepad "ultimate chicken horse"`, `phonepad "bummerang fu"`, `phonepad "ibb&obb"`, and `phonepad "plate up"`.

Custom layouts:

```bash
phonepad --joystick smooth --buttons A,B,X,Y
phonepad --joystick none --buttons A,B,START,SELECT
phonepad driving --players auto
phonepad driving --players adaptive
phonepad driving --players 8
phonepad --inputs throttle,brake,gearUp,gearDown
phonepad --preset driving --haptics off
phonepad ultimate-chicken-horse -d
```

`phonepad` (no args) uses URL/admin token from `.env` and default `classic` layout.

## Debug state

`/state` requires the admin token in public mode:

```bash
curl "https://phonepad.nickesselman.nl/state?token=YOUR_TOKEN"
```

## Stable phone identity

The controller stores a persistent `deviceId` in browser local storage and reuses the same player id after refresh/reconnect.
This is more reliable than IP or MAC (not available/stable in browsers across networks).
Server keeps this mapping for 24 hours of inactivity by default.

## Connection stability behavior

- Adaptive reconnect backoff: starts fast and grows up to 3s.
- Offline-aware retry: if phone goes offline, it waits for network restore.
- Controller keeps sending low-overhead keepalive updates plus immediate state-change updates.
- Server heartbeat runs only while clients are connected (lower idle CPU).

## Real-time input listener (recommended for games)

Polling `/state` can miss very short taps. Use the observer WebSocket listener:

```bash
node observe-inputs.js
```

It reads `PHONEPAD_PUBLIC_URL` and `PHONEPAD_ACCESS_TOKEN` from `.env` and prints press/release events:

```text
2026-03-05T10:00:00.000Z player=1 button=A event=down
2026-03-05T10:00:00.083Z player=1 button=A event=up
```

## Laptop gamepad client (for browser/game detection)

This creates a Linux virtual gamepad from PhonePad input so sites like `hardwaretester.com/gamepad` can see it.

### 1) Install laptop dependency (Arch Linux)

```bash
sudo pacman -S python-evdev
sudo modprobe uinput
```

If `/dev/uinput` is permission denied, run the client with sudo or grant your user access to that device.

### 2) Start the client

It reads `.env` by default:

```bash
phonepad
```

`npm run client` also runs the same command.
The command prints a QR code and keeps running until `Ctrl+C`.
By default it now uses a stable auto pool: it pre-creates 4 virtual controllers on startup and can still expand later if more players join.
This avoids the late virtual-gamepad hotplug that breaks controller ordering in some games.
If you want the old lazy behavior, use `phonepad --players adaptive`.
If you already know the exact player count, `phonepad --players 4` or `PHONEPAD_MAX_PLAYERS=12` keeps the device list fixed.
The QR code and phone URL use a reboot-scoped controller session token generated on the laptop. The long-lived `PHONEPAD_ACCESS_TOKEN` stays on the laptop/server side for admin actions like publishing layout changes and observer access.

Or pass URL/admin token explicitly:

```bash
phonepad https://phonepad.nickesselman.nl YOUR_TOKEN
```

### Debug mode

Use `-d` or `--debug` to print verbose laptop-side logs for observer reconnects, player snapshots, slot assignment, and per-player routed input summaries:

```bash
phonepad ultimate-chicken-horse -d
```

### 3) Test in browser

Keep `npm run client` running on your laptop, open `https://hardwaretester.com/gamepad`, then press buttons on the phone controller page.
