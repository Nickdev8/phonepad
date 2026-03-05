import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_INPUT_KEYS = Object.freeze(['up', 'down', 'left', 'right', 'A', 'B']);
const DISCONNECT_GRACE_MS = 8000;
const DEVICE_RETENTION_MS = 24 * 60 * 60 * 1000;

function sanitizeInputKeys(rawInputKeys) {
  const sourceKeys = Array.isArray(rawInputKeys)
    ? rawInputKeys
    : String(rawInputKeys ?? '')
        .split(',')
        .map((item) => item.trim());

  const sanitized = [];
  const seen = new Set();
  for (const rawKey of sourceKeys) {
    const key = String(rawKey ?? '').trim();
    if (!key || key.length > 24) {
      continue;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sanitized.push(key);
  }

  return sanitized.length > 0 ? sanitized : [...DEFAULT_INPUT_KEYS];
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

function getRequestUrl(request) {
  const host = request.headers.host ?? 'localhost';
  const protocol = request.headers['x-forwarded-proto'] ?? 'http';
  return new URL(request.url ?? '/', `${protocol}://${host}`);
}

function getTokenFromRequest(request) {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const requestUrl = getRequestUrl(request);
  return requestUrl.searchParams.get('token') ?? '';
}

function getDeviceIdFromRequest(request) {
  const value = getRequestUrl(request).searchParams.get('device') ?? '';
  const deviceId = value.trim();
  if (!deviceId) {
    return '';
  }

  if (deviceId.length > 128) {
    return '';
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
    return '';
  }

  return deviceId;
}

function isAuthorizedRequest(request, accessToken) {
  if (!accessToken) {
    return true;
  }

  return tokensMatch(accessToken, getTokenFromRequest(request));
}

export function startPhonePadServer({
  port = 3000,
  host = '0.0.0.0',
  accessToken = '',
  inputKeys = DEFAULT_INPUT_KEYS
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const controllerWss = new WebSocketServer({ noServer: true });
  const observerWss = new WebSocketServer({ noServer: true });
  const players = new Map();
  const deviceToPlayerId = new Map();
  const observers = new Set();
  const requiredAccessToken = String(accessToken ?? '').trim();
  const configuredInputKeys = sanitizeInputKeys(inputKeys);
  let nextPlayerId = 1;

  const createEmptyState = () =>
    Object.fromEntries(configuredInputKeys.map((key) => [key, false]));

  const normalizeState = (input = {}) =>
    Object.fromEntries(configuredInputKeys.map((key) => [key, Boolean(input[key])]));

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/config', (req, res) => {
    if (!isAuthorizedRequest(req, requiredAccessToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    res.json({
      inputs: configuredInputKeys
    });
  });

  app.get('/state', (req, res) => {
    if (!isAuthorizedRequest(req, requiredAccessToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const allPlayers = {};
    for (const [playerId, data] of players) {
      if (!data.socket) {
        continue;
      }

      allPlayers[playerId] = data.state;
    }

    res.json({ players: allPlayers });
  });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = getRequestUrl(request);

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

  controllerWss.on('connection', (socket, request) => {
    const deviceId = getDeviceIdFromRequest(request);
    let playerId = '';
    let player;
    let resumed = false;

    if (deviceId) {
      const existingPlayerId = deviceToPlayerId.get(deviceId);
      if (existingPlayerId) {
        playerId = existingPlayerId;
        player = players.get(existingPlayerId);
      }
    }

    if (!player) {
      playerId = String(nextPlayerId++);
      player = {
        state: createEmptyState(),
        deviceId,
        socket: null,
        disconnectTimer: null,
        cleanupTimer: null
      };
      players.set(playerId, player);
      if (deviceId) {
        deviceToPlayerId.set(deviceId, playerId);
      }

      console.log(`player connected (${playerId})`);
      broadcastToObservers({
        type: 'player_connected',
        playerId,
        timestamp: Date.now()
      });
    } else {
      resumed = true;
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      if (player.cleanupTimer) {
        clearTimeout(player.cleanupTimer);
        player.cleanupTimer = null;
      }

      if (player.socket && player.socket !== socket && player.socket.readyState === WebSocket.OPEN) {
        player.socket.terminate();
      }

      if (deviceId) {
        player.deviceId = deviceId;
        deviceToPlayerId.set(deviceId, playerId);
      }

      console.log(`player reconnected (${playerId})`);
      broadcastToObservers({
        type: 'player_reconnected',
        playerId,
        timestamp: Date.now()
      });
    }

    player.socket = socket;

    socket.send(
      JSON.stringify({
        type: 'welcome',
        playerId,
        resumed
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
      const currentPlayer = players.get(playerId);
      if (!currentPlayer || currentPlayer.socket !== socket) {
        return;
      }

      currentPlayer.socket = null;
      if (currentPlayer.disconnectTimer) {
        clearTimeout(currentPlayer.disconnectTimer);
      }
      if (currentPlayer.cleanupTimer) {
        clearTimeout(currentPlayer.cleanupTimer);
        currentPlayer.cleanupTimer = null;
      }

      currentPlayer.disconnectTimer = setTimeout(() => {
        const latestPlayer = players.get(playerId);
        if (!latestPlayer || latestPlayer.socket) {
          return;
        }

        console.log(`player disconnected (${playerId})`);
        broadcastToObservers({
          type: 'player_disconnected',
          playerId,
          timestamp: Date.now()
        });

        latestPlayer.disconnectTimer = null;
        latestPlayer.cleanupTimer = setTimeout(() => {
          const inactivePlayer = players.get(playerId);
          if (!inactivePlayer || inactivePlayer.socket) {
            return;
          }

          players.delete(playerId);
          if (inactivePlayer.deviceId && deviceToPlayerId.get(inactivePlayer.deviceId) === playerId) {
            deviceToPlayerId.delete(inactivePlayer.deviceId);
          }
        }, DEVICE_RETENTION_MS);
        latestPlayer.cleanupTimer.unref?.();
      }, DISCONNECT_GRACE_MS);
      currentPlayer.disconnectTimer.unref?.();
    });
  });

  observerWss.on('connection', (socket) => {
    observers.add(socket);

    const currentPlayers = {};
    for (const [playerId, data] of players) {
      if (!data.socket) {
        continue;
      }

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
