const statusElement = document.getElementById('status');

const state = {
  up: false,
  down: false,
  left: false,
  right: false,
  A: false,
  B: false
};

let socket;

function setConnectionStatus(isConnected) {
  statusElement.textContent = isConnected ? 'connected' : 'disconnected';
  statusElement.classList.toggle('connected', isConnected);
  statusElement.classList.toggle('disconnected', !isConnected);
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    setConnectionStatus(true);
  });

  socket.addEventListener('close', () => {
    setConnectionStatus(false);
    setTimeout(connectWebSocket, 1000);
  });

  socket.addEventListener('error', () => {
    setConnectionStatus(false);
  });
}

function setButtonState(button, key, pressed) {
  state[key] = pressed;
  button.classList.toggle('active', pressed);
}

function bindButton(buttonId, key) {
  const button = document.getElementById(buttonId);

  const press = (event) => {
    event.preventDefault();
    setButtonState(button, key, true);
  };

  const release = (event) => {
    event.preventDefault();
    setButtonState(button, key, false);
  };

  button.addEventListener('touchstart', press, { passive: false });
  button.addEventListener('touchend', release, { passive: false });
  button.addEventListener('touchcancel', release, { passive: false });

  button.addEventListener('mousedown', press);
  button.addEventListener('mouseup', release);
  button.addEventListener('mouseleave', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

bindButton('btn-up', 'up');
bindButton('btn-down', 'down');
bindButton('btn-left', 'left');
bindButton('btn-right', 'right');
bindButton('btn-A', 'A');
bindButton('btn-B', 'B');

connectWebSocket();

setInterval(() => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'input',
      state
    })
  );
}, 1000 / 60);
