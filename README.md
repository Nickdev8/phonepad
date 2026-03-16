# PhonePad

Phone-based game controller over WebSockets.

## Run

```bash
npm install
npm start
```

Server entrypoint: `npm run server`

## Public Setup

1. Copy `.env.example` to `.env`
2. Set `PHONEPAD_PUBLIC_URL`
3. Set `PHONEPAD_ACCESS_TOKEN`
4. Run:

```bash
docker compose up -d --build
```

Proxy or tunnel your domain to port `3017` with WebSocket upgrades enabled.

## Client

```bash
npm run client
```

Or use:

```bash
phonepad
```

Useful commands:

```bash
phonepad --list-layouts
phonepad shooter
phonepad driving
phonepad driving --players 8
npm run observe
```

For Linux virtual gamepad output:

```bash
sudo pacman -S python-evdev
sudo modprobe uinput
```

Debug polling script: [`scripts/poll-state.sh`](scripts/poll-state.sh)

## License

No license specified.

## Credits

Nick: 99%+ of the work.
Tom: prompt engineering for 1 ai prompt. 
