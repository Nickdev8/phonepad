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
   - `PHONEPAD_ACCESS_TOKEN` to a long random secret
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
phonepad driving --players 8
phonepad --inputs throttle,brake,gearUp,gearDown
phonepad --preset driving --haptics off
```

`phonepad` (no args) uses URL/token from `.env` and default `classic` layout.

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
phonepad
```

`npm run client` also runs the same command.
The command prints a QR code and keeps running until `Ctrl+C`.
By default it uses an adaptive controller pool: it starts with the first active player and creates additional virtual controllers only when more players actually join.
If you already know how many players you need before launching the game, `phonepad --players 4` or `PHONEPAD_MAX_PLAYERS=12` is still the most stable option because it avoids later hotplug growth.

Or pass URL/token explicitly:

```bash
phonepad https://phonepad.nickesselman.nl YOUR_TOKEN
```

### 3) Test in browser

Keep `npm run client` running on your laptop, open `https://hardwaretester.com/gamepad`, then press buttons on the phone controller page.
