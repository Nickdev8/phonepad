import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startPhonePadServer } from './server.js';

function getBoundBaseUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object' && 'port' in address);
  return `http://127.0.0.1:${address.port}`;
}

test('controller session token replaces the admin token for phone endpoints', async (t) => {
  const runningServer = await startPhonePadServer({
    port: 0,
    host: '127.0.0.1',
    accessToken: 'admin-secret'
  });

  t.after(async () => {
    await runningServer.stop();
  });

  const baseUrl = getBoundBaseUrl(runningServer.server);

  let response = await fetch(`${baseUrl}/config?token=admin-secret`);
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer admin-secret'
    },
    body: JSON.stringify({
      controllerToken: 'controller-secret'
    })
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/config?token=admin-secret`);
  assert.equal(response.status, 401);

  response = await fetch(`${baseUrl}/config?token=controller-secret`);
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/state?token=admin-secret`);
  assert.equal(response.status, 200);
});

test('rotating the controller session token disconnects old phone sockets', async (t) => {
  const runningServer = await startPhonePadServer({
    port: 0,
    host: '127.0.0.1',
    accessToken: 'admin-secret'
  });

  t.after(async () => {
    await runningServer.stop();
  });

  const baseUrl = getBoundBaseUrl(runningServer.server);
  const publishSessionToken = async (controllerToken) => {
    const response = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer admin-secret'
      },
      body: JSON.stringify({
        controllerToken
      })
    });
    assert.equal(response.status, 200);
  };

  await publishSessionToken('controller-secret-a');

  const wsBaseUrl = new URL(baseUrl);
  wsBaseUrl.protocol = 'ws:';
  wsBaseUrl.pathname = '/ws';
  wsBaseUrl.search = '';
  wsBaseUrl.searchParams.set('token', 'controller-secret-a');

  const controllerSocket = new WebSocket(wsBaseUrl);
  await once(controllerSocket, 'open');

  const closePromise = new Promise((resolve, reject) => {
    controllerSocket.once('close', (code, reason) => {
      resolve({
        code,
        reason: reason.toString()
      });
    });
    controllerSocket.once('error', reject);
  });

  await publishSessionToken('controller-secret-b');

  const closeResult = await closePromise;
  assert.equal(closeResult.code, 4001);
  assert.equal(closeResult.reason, 'controller_token_rotated');
});
