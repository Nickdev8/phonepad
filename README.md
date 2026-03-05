# PhonePad

Minimal smartphone controller over WebSockets.

## Local run

```bash
npm install
node cli.js server
```

## Public run (server/subdomain)

1. Copy `.env.example` to `.env`.
2. Set:
   - `PHONEPAD_PUBLIC_URL` to your public HTTPS URL (for example `https://phonepad.nickesselman.nl`)
   - `PHONEPAD_ACCESS_TOKEN` to a long random secret
   - optional: `PHONEPAD_PRESET` one of `classic|arcade|shooter|driving|minimal`
   - optional: `PHONEPAD_JOYSTICK` one of `dpad|smooth|none`
   - optional: `PHONEPAD_BUTTONS` comma list (for example `A,B,X,Y`)
   - optional: `PHONEPAD_INPUTS` full comma list override (for example `up,down,left,right,A,B,X,Y`)
   - optional: `PHONEPAD_HAPTICS=on|off`
3. Start:

```bash
docker compose up -d --build
```

Open the controller URL printed in logs:

```bash
docker compose logs -f phonepad
```

The URL includes `?token=...`. Keep that link private.

## Reverse proxy / tunnel requirement

Point your subdomain (or tunnel) to this container's `3017` port and keep WebSocket upgrade support enabled.

## Fullscreen on phone

The page now supports both portrait and landscape with no scrolling.
For true browser-chrome-free fullscreen on mobile, open from home screen (PWA standalone) or tap the `Fullscreen` button.
When a token is present in the URL once, the controller caches it locally so standalone launches keep working.

## Layout setup command

The server controls the visible controls. When `phonepad server` starts, it prints layout options and quick examples before the QR code.

List all layouts:

```bash
phonepad server --list-layouts
```

Preset layouts:

```bash
phonepad server --preset arcade
phonepad server --preset shooter
```

Custom layouts:

```bash
phonepad server --joystick smooth --buttons A,B,X,Y
phonepad server --joystick none --buttons A,B,START,SELECT
phonepad server --inputs throttle,brake,gearUp,gearDown
phonepad server --preset driving --haptics off
```

Environment equivalents also work (`PHONEPAD_PRESET`, `PHONEPAD_JOYSTICK`, `PHONEPAD_BUTTONS`, `PHONEPAD_INPUTS`, `PHONEPAD_HAPTICS`).

## Debug state

`/state` requires the same token in public mode:

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
phonepad client
```

`npm run client` also works and runs the same command.
The command prints a QR code and keeps running until `Ctrl+C`.

Plain `phonepad` also starts this client mode.

Or pass URL/token explicitly:

```bash
node client.js https://phonepad.nickesselman.nl YOUR_TOKEN
```

### 3) Test in browser

Keep `npm run client` running on your laptop, open `https://hardwaretester.com/gamepad`, then press buttons on the phone controller page.
