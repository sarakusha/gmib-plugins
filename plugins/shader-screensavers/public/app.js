'use strict';

/* cspell:ignore Truchet truchet */

(() => {
  const form = document.querySelector('[data-settings-form]');
  const status = document.querySelector('[data-status]');
  const sceneName = document.querySelector('[data-scene-name]');
  const screenMessages = [...document.querySelectorAll('[data-screen-message]')];
  const sceneNames = {
    truchet: 'Truchet Flow',
    aurora: 'Aurora Veil',
    plasma: 'Liquid Plasma',
    topography: 'Contour Drift',
  };
  const fields = [...document.querySelectorAll('[data-shader-canvas]')].map(canvas => {
    try {
      return new window.ShaderField(canvas);
    } catch (error) {
      screenMessages.forEach(message => {
        message.textContent = error.message;
        message.classList.add('is-visible', 'is-error');
      });
      return null;
    }
  });
  let state;
  let saveTimer;
  let reconnectTimer;

  const setStatus = (message, kind = '') => {
    if (!status) return;
    status.querySelector('b').textContent = message;
    status.dataset.kind = kind;
  };

  const request = async (path, options) => {
    const response = await fetch(`api/${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  const formState = () => {
    const data = new FormData(form);
    return {
      scene: data.get('scene'),
      speed: Number(data.get('speed')),
      scale: Number(data.get('scale')),
      brightness: Number(data.get('brightness')),
      patternOpacity: Number(data.get('patternOpacity')),
      backgroundOpacity: Number(data.get('backgroundOpacity')),
      colorA: data.get('colorA'),
      colorB: data.get('colorB'),
      background: data.get('background'),
      animate: data.has('animate'),
    };
  };

  const renderForm = () => {
    if (!form || !state) return;
    for (const [name, value] of Object.entries(state)) {
      [...form.elements]
        .filter(field => field.name === name)
        .forEach(field => {
          if (field.type === 'checkbox') field.checked = value;
          else if (field.type === 'radio') field.checked = field.value === value;
          else field.value = value;
        });
    }
    form.querySelectorAll('[data-output-for]').forEach(output => {
      const value = state[output.dataset.outputFor];
      output.textContent = `${value}%`;
    });
  };

  const render = (nextState, updateForm = true) => {
    state = nextState;
    fields.forEach(field => field?.apply(state));
    screenMessages.forEach(message => message.classList.remove('is-visible'));
    if (sceneName) sceneName.textContent = sceneNames[state.scene] || state.scene;
    if (updateForm) renderForm();
  };

  const save = async () => {
    try {
      setStatus('Сохранение');
      render(await request('state', { method: 'PUT', body: JSON.stringify(formState()) }));
      setStatus('Сохранено', 'ready');
    } catch (error) {
      setStatus(`Ошибка · ${error.message}`, 'error');
    }
  };

  form?.addEventListener('input', () => {
    clearTimeout(saveTimer);
    render(formState(), false);
    renderForm();
    setStatus('Изменено');
    saveTimer = setTimeout(save, 160);
  });
  form?.addEventListener('submit', event => event.preventDefault());

  document.querySelector('[data-aspect]')?.addEventListener('change', event => {
    const shell = document.querySelector('[data-preview-shell]');
    const fixed = event.currentTarget.value !== 'free';
    shell.style.aspectRatio = fixed ? event.currentTarget.value : '';
    shell.classList.toggle('has-fixed-aspect', fixed);
  });

  const connect = () => {
    clearTimeout(reconnectTimer);
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}`);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ sourceId: Date.now() }));
      if (form) setStatus('Сохранено', 'ready');
    });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'plugin:shader-screensavers:changed' && message.data?.[0]) {
          render(message.data[0]);
        }
      } catch {
        // Остальные сообщения принадлежат другим подсистемам gmib.
      }
    });
    socket.addEventListener('close', () => {
      if (form) setStatus('Нет связи', 'error');
      reconnectTimer = setTimeout(connect, 1500);
    });
  };

  void request('state')
    .then(nextState => {
      render(nextState);
      if (form) setStatus('Сохранено', 'ready');
    })
    .catch(error => {
      screenMessages.forEach(message => {
        message.textContent = `Нет данных · ${error.message}`;
        message.classList.add('is-visible', 'is-error');
      });
      if (form) setStatus(`Ошибка · ${error.message}`, 'error');
    });
  connect();
})();
