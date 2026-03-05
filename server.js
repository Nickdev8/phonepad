import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMPTY_STATE = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  A: false,
  B: false
});

function normalizeState(input = {}) {
  return {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    A: Boolean(input.A),
    B: Boolean(input.B)
  };
}

export function startPhonePadServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const players = new Map();
  let nextPlayerId = 1;

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/state', (_req, res) => {
    const allPlayers = {};
    for (const [playerId, data] of players) {
      allPlayers[playerId] = data.state;
    }

    res.json({ players: allPlayers });
  });

  wss.on('connection', (socket) => {
    const playerId = String(nextPlayerId++);
    players.set(playerId, { state: { ...EMPTY_STATE } });
    console.log(`player connected (${playerId})`);

    socket.send(
      JSON.stringify({
        type: 'welcome',
        playerId
      })
    );

    socket.on('message', (payload) => {
      let message;
      try {
        message = JSON.parse(payload.toString());
      } catch {
        return;
      }

      if (message.type !== 'input' || typeof message.state !== 'object' || message.state === null) {
        return;
      }

      const player = players.get(playerId);
      if (!player) {
        return;
      }

      player.state = normalizeState(message.state);
    });

    socket.on('close', () => {
      players.delete(playerId);
      console.log(`player disconnected (${playerId})`);
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };

    server.on('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve({
        app,
        server,
        wss,
        players,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
            wss.close(() => {
              server.close((error) => {
                if (error) {
                  stopReject(error);
                  return;
                }

                stopResolve();
              });
            });
          })
      });
    });
  });
}
