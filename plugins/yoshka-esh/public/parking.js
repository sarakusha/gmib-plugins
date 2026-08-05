'use strict';

const settingsForm = document.querySelector('[data-settings-form]');
const statusElement = document.querySelector('[data-status]');
const displays = [...document.querySelectorAll('[data-display]')];
let state;
let saveTimer;
let alternateTimer;
let alternateLogo = false;

const showStatus = (message, error = false) => {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.classList.toggle('error', error);
};

const request = async (path, options) => {
  const response = await fetch(`api/${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const setBrandState = (display, mode) => {
  display.dataset.bottomMode = mode;
  display.classList.toggle('show-alternate-logo', mode === 'alternate' && alternateLogo);
};

const restartAlternateTimer = () => {
  clearInterval(alternateTimer);
  alternateLogo = false;
  displays.forEach(display => setBrandState(display, state.bottomMode));
  if (state.bottomMode !== 'alternate') return;
  alternateTimer = setInterval(() => {
    alternateLogo = !alternateLogo;
    displays.forEach(display => setBrandState(display, state.bottomMode));
  }, state.switchInterval * 1000);
};

const renderDisplay = display => {
  display.querySelector('[data-count]').textContent = String(state.spaces);
  const sign = display.querySelector('[data-parking-sign]');
  const caption = display.querySelector('[data-caption]');
  const digits = String(state.spaces).length;
  const fittedCounterSize = Math.min(state.counterSize, Math.floor(535 / digits));
  sign.style.width = `${(state.parkingSize / 3.2).toFixed(3)}%`;
  display.style.setProperty('--counter-size', `${(fittedCounterSize / 3.2).toFixed(3)}cqw`);
  display.style.setProperty('--caption-size', `${(state.captionSize / 3.2).toFixed(3)}cqw`);
  display.style.setProperty('--background-opacity', (state.backgroundOpacity / 100).toFixed(2));
  const textShadowLevel = state.textShadow / 100;
  const textShadow =
    textShadowLevel <= 0.45 ? textShadowLevel : 0.45 + (textShadowLevel - 0.45) * 1.4;
  display.style.setProperty('--text-stroke-opacity', (textShadow * 0.38).toFixed(3));
  display.style.setProperty('--text-edge-opacity', (textShadow * 0.62).toFixed(3));
  display.style.setProperty('--text-shadow-opacity', (textShadow * 0.4).toFixed(3));
  display.classList.toggle('compact-digits', state.compactDigits);
  caption.hidden = !state.captionVisible;
  setBrandState(display, state.bottomMode);
};

const renderForm = () => {
  if (!settingsForm) return;
  for (const [name, value] of Object.entries(state)) {
    const fields = [...settingsForm.elements].filter(field => field.name === name);
    fields.forEach(field => {
      if (field.type === 'checkbox') field.checked = value;
      else if (field.type === 'radio') field.checked = field.value === value;
      else field.value = value;
    });
  }
  settingsForm.querySelector('[data-caption-size-field]').hidden = !state.captionVisible;
  settingsForm.querySelector('[data-interval-field]').hidden = state.bottomMode !== 'alternate';
  settingsForm.querySelectorAll('[data-output-for]').forEach(output => {
    const value = state[output.dataset.outputFor];
    if (output.dataset.outputFor === 'switchInterval') output.textContent = `${value} с`;
    else if (['backgroundOpacity', 'textShadow'].includes(output.dataset.outputFor))
      output.textContent = `${value}%`;
    else output.textContent = `${value} px`;
  });
};

const render = (nextState, updateForm = true) => {
  const timerChanged =
    !state ||
    state.bottomMode !== nextState.bottomMode ||
    state.switchInterval !== nextState.switchInterval;
  state = nextState;
  displays.forEach(renderDisplay);
  if (updateForm) renderForm();
  if (timerChanged) restartAlternateTimer();
};

const formState = () => {
  const data = new FormData(settingsForm);
  return {
    spaces: Number(data.get('spaces')),
    parkingSize: Number(data.get('parkingSize')),
    counterSize: Number(data.get('counterSize')),
    textShadow: Number(data.get('textShadow')),
    compactDigits: data.has('compactDigits'),
    captionVisible: data.has('captionVisible'),
    captionSize: Number(data.get('captionSize')),
    bottomMode: data.get('bottomMode'),
    switchInterval: Number(data.get('switchInterval')),
    backgroundOpacity: Number(data.get('backgroundOpacity')),
  };
};

const save = async () => {
  try {
    showStatus('Сохранение…');
    render(await request('state', { method: 'PUT', body: JSON.stringify(formState()) }));
    showStatus('Сохранено');
  } catch (error) {
    showStatus(`Ошибка: ${error.message}`, true);
  }
};

const queueSave = () => {
  clearTimeout(saveTimer);
  render(formState(), false);
  renderForm();
  saveTimer = setTimeout(save, 180);
};

settingsForm?.addEventListener('input', queueSave);
settingsForm?.addEventListener('submit', event => event.preventDefault());
document.querySelector('[data-decrement]')?.addEventListener('click', async () => {
  clearTimeout(saveTimer);
  render(await request('decrement', { method: 'POST', body: '{}' }));
  showStatus('Сохранено');
});
document.querySelector('[data-increment]')?.addEventListener('click', async () => {
  clearTimeout(saveTimer);
  render(await request('increment', { method: 'POST', body: '{}' }));
  showStatus('Сохранено');
});

const connect = () => {
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  );
  socket.addEventListener('open', () => socket.send(JSON.stringify({ sourceId: Date.now() })));
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.event === 'plugin:yoshka-esh:changed') render(message.data?.[0]);
    } catch {
      // Остальные сообщения принадлежат другим подсистемам gmib.
    }
  });
  socket.addEventListener('close', () => setTimeout(connect, 1500));
};

void request('state')
  .then(nextState => {
    render(nextState);
    showStatus('Сохранено');
  })
  .catch(error => showStatus(`Ошибка: ${error.message}`, true));
connect();
