import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

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

function tokensMatch(expectedToken, providedToken) {
  if (!expectedToken) {
    return true;
  }

  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  const providedBuffer = Buffer.from(providedToken ?? '', 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function getTokenFromRequest(request) {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const host = request.headers.host ?? 'localhost';
  const protocol = request.headers['x-forwarded-proto'] ?? 'http';
  const requestUrl = new URL(request.url ?? '/', `${protocol}://${host}`);
  return requestUrl.searchParams.get('token') ?? '';
}

function isAuthorizedRequest(request, accessToken) {
  if (!accessToken) {
    return true;
  }

  return tokensMatch(accessToken, getTokenFromRequest(request));
}

export function startPhonePadServer({ port = 3000, host = '0.0.0.0', accessToken = '' } = {}) {
  const app = express();
  const server = http.createServer(app);
  const controllerWss = new WebSocketServer({ noServer: true });
  const observerWss = new WebSocketServer({ noServer: true });
  const players = new Map();
  const observers = new Set();
  const requiredAccessToken = String(accessToken ?? '').trim();
  let nextPlayerId = 1;

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/state', (req, res) => {
    if (!isAuthorizedRequest(req, requiredAccessToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const allPlayers = {};
    for (const [playerId, data] of players) {
      allPlayers[playerId] = data.state;
    }

    res.json({ players: allPlayers });
  });

  server.on('upgrade', (request, socket, head) => {
    const hostHeader = request.headers.host ?? 'localhost';
    const protocol = request.headers['x-forwarded-proto'] ?? 'http';
    const requestUrl = new URL(request.url ?? '/', `${protocol}://${hostHeader}`);

    if (requestUrl.pathname !== '/ws' && requestUrl.pathname !== '/observe') {
      socket.destroy();
      return;
    }

    if (!isAuthorizedRequest(request, requiredAccessToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (requestUrl.pathname === '/ws') {
      controllerWss.handleUpgrade(request, socket, head, (websocket) => {
        controllerWss.emit('connection', websocket, request);
      });
      return;
    }

    observerWss.handleUpgrade(request, socket, head, (websocket) => {
      observerWss.emit('connection', websocket, request);
    });
  });

  const broadcastToObservers = (payload) => {
    const encoded = JSON.stringify(payload);
    for (const observer of observers) {
      if (observer.readyState !== WebSocket.OPEN) {
        continue;
      }

      observer.send(encoded);
    }
  };

  controllerWss.on('error', (error) => {
    console.error(`WebSocket server error: ${error.message}`);
  });

  observerWss.on('error', (error) => {
    console.error(`Observer WebSocket error: ${error.message}`);
  });

  controllerWss.on('connection', (socket) => {
    const playerId = String(nextPlayerId++);
    players.set(playerId, { state: { ...EMPTY_STATE } });
    console.log(`player connected (${playerId})`);
    broadcastToObservers({
      type: 'player_connected',
      playerId,
      timestamp: Date.now()
    });

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
      broadcastToObservers({
        type: 'input',
        playerId,
        state: player.state,
        timestamp: Date.now()
      });
    });

    socket.on('close', () => {
      players.delete(playerId);
      console.log(`player disconnected (${playerId})`);
      broadcastToObservers({
        type: 'player_disconnected',
        playerId,
        timestamp: Date.now()
      });
    });
  });

  observerWss.on('connection', (socket) => {
    observers.add(socket);

    const currentPlayers = {};
    for (const [playerId, data] of players) {
      currentPlayers[playerId] = data.state;
    }

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        players: currentPlayers,
        timestamp: Date.now()
      })
    );

    socket.on('close', () => {
      observers.delete(socket);
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
        wss: controllerWss,
        observerWss,
        players,
        stop: () =>
          new Promise((stopResolve, stopReject) => {
            let pending = 2;
            const onWsClosed = () => {
              pending -= 1;
              if (pending !== 0) {
                return;
              }

              server.close((error) => {
                if (error) {
                  stopReject(error);
                  return;
                }

                stopResolve();
              });
            };

            controllerWss.close(onWsClosed);
            observerWss.close(onWsClosed);
          })
      });
    });
  });
}
