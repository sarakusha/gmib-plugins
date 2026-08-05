'use strict';

const count = document.querySelector('[data-count]');
const status = document.querySelector('[data-status]');

const render = spaces => {
  if (count) count.textContent = String(spaces);
};

const showStatus = (message, error = false) => {
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
};

const request = async (path, options) => {
  const response = await fetch(`api/${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const state = await response.json();
  render(state.spaces);
  return state;
};

const update = async (path, body) => {
  try {
    showStatus('Обновление…');
    await request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    showStatus('Сохранено');
  } catch (error) {
    showStatus(`Ошибка: ${error.message}`, true);
  }
};

document.querySelector('[data-decrement]')?.addEventListener('click', () => update('decrement'));
document.querySelector('[data-increment]')?.addEventListener('click', () => update('increment'));
document.querySelector('[data-set-form]')?.addEventListener('submit', async event => {
  event.preventDefault();
  const input = event.currentTarget.elements.spaces;
  try {
    showStatus('Обновление…');
    await request('state', {
      method: 'PUT',
      body: JSON.stringify({ spaces: input.value }),
    });
    input.value = '';
    showStatus('Сохранено');
  } catch (error) {
    showStatus(`Ошибка: ${error.message}`, true);
  }
});

const connect = () => {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ sourceId: Date.now() })));
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.event === 'plugin:parking-counter:changed') {
        render(message.data?.[0]?.spaces);
      }
    } catch {
      // Ignore messages belonging to other gmib subsystems.
    }
  });
  socket.addEventListener('close', () => setTimeout(connect, 1500));
};

void request('state').catch(error => showStatus(`Ошибка: ${error.message}`, true));
connect();
