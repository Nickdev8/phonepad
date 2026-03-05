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
