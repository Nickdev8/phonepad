# PhonePad

Minimal smartphone controller over WebSockets.

## Local run

```bash
npm install
node cli.js
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

## Debug state

`/state` requires the same token in public mode:

```bash
curl "https://phonepad.nickesselman.nl/state?token=YOUR_TOKEN"
```

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
npm run client
```

Or pass URL/token explicitly:

```bash
node client.js https://phonepad.nickesselman.nl YOUR_TOKEN
```

### 3) Test in browser

Keep `npm run client` running on your laptop, open `https://hardwaretester.com/gamepad`, then press buttons on the phone controller page.
