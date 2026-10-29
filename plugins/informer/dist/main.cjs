'use strict';

const { defaults, validateSettings, normalizeWeather, restoreWeather } = require('./model.cjs');
const sample = require('./sample.json');
const STORAGE_KEY = 'informer.v1';
const ENDPOINT = 'https://api.weather.yandex.ru/v2/informers';

exports.activate = async ({ storage, http, events, output, logger }) => {
  let saved = await storage.get(STORAGE_KEY);
  if (!saved || saved.version !== 1) saved = {};
  let settings, weather, restored = true;
  try { settings = validateSettings(saved.settings); } catch { settings = structuredClone(defaults); }
  try { weather = restoreWeather(saved.weather); } catch { weather = normalizeWeather(sample, 0); restored = false; }
  let record = { version: 1, settings, weather,
    cache: { mode: 'frozen', origin: restored && ['sample', 'capture', 'import'].includes(saved.cache?.origin) ? saved.cache.origin : 'sample',
      fetchedAt: weather.fetchedAt,
      attemptedAt: Number.isFinite(saved.cache?.attemptedAt) && saved.cache.attemptedAt >= 0 ? saved.cache.attemptedAt : null,
      message: restored && typeof saved.cache?.message === 'string' ? saved.cache.message.slice(0, 240) : 'Сохранённый пример. Автоматические запросы выключены.' } };
  const snapshot = () => structuredClone({ settings: record.settings, weather: record.weather, cache: record.cache });
  const persist = async next => {
    await storage.set(STORAGE_KEY, next);
    record = next;
    events.publish('changed', snapshot());
    return snapshot();
  };
  let queue = Promise.resolve();
  const serial = work => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const error = (status, message) => http.response(status, { error: message });
  const route = work => async request => {
    try { return await work(request); }
    catch { logger.warn('Informer: не удалось сохранить данные или выполнить операцию'); return error(500, 'Операция не выполнена. Проверьте журнал GMIB.'); }
  };
  http.get('/state', () => snapshot());
  http.put('/settings', route(request => serial(async () => {
    let settings;
    try { settings = validateSettings(request.body); } catch (err) { return error(422, err.message); }
    return persist({ ...record, settings });
  })));
  http.post('/weather/import', route(request => serial(async () => {
    let weather;
    try { weather = normalizeWeather(request.body?.data); } catch (err) { return error(422, err.message); }
    return persist({ ...record, weather, cache: { ...record.cache, origin: 'import', fetchedAt: weather.fetchedAt,
      message: 'Прогноз импортирован и заморожен. Сетевых запросов нет.' } });
  })));
  http.post('/weather/capture', route(request => serial(async () => {
    if (record.cache.attemptedAt !== null) return error(409, 'Однократная попытка уже использована. Прогноз можно импортировать из JSON.');
    const { apiKey, lat, lon } = request.body || {};
    if (typeof apiKey !== 'string' || !/^[a-zA-Z0-9_-]{16,200}$/.test(apiKey) ||
      typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
      typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return error(422, 'Проверьте API-ключ и координаты.');
    // Reserve before dispatch. Failed requests and interrupted processes must not retry on restart.
    await persist({ ...record, cache: { ...record.cache, attemptedAt: Date.now(), message: 'Однократный запрос отправляется; повтор отключён.' } });
    let response, weather;
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set('lat', String(lat)); url.searchParams.set('lon', String(lon)); url.searchParams.set('lang', 'ru_RU');
      response = await fetch(url, { headers: { 'X-Yandex-Weather-Key': apiKey },
        signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error('provider');
      // Bound the response while reading, including chunked transfer bodies.
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('response too large');
        chunks.push(Buffer.from(chunk));
      }
      weather = normalizeWeather(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      const code = response && !response.ok ? ` HTTP ${response.status}.` : '';
      const message = `Прогноз не загружен.${code} Сохранён предыдущий снимок; автоматического повтора нет.`;
      await persist({ ...record, cache: { ...record.cache, message } });
      return error(502, message);
    }
    return persist({ ...record, weather, cache: { ...record.cache, origin: 'capture', fetchedAt: weather.fetchedAt,
      message: 'Прогноз загружен один раз и заморожен. Автоматические запросы выключены.' } });
  })));
  http.get('/output', route(async () => http.response(200, { screens: await output.listScreens(), status: await output.getStatus() })));
  http.put('/output', route(async request => {
    const {screenId, pageId, autoStart} = request.body || {};
    if (!Number.isSafeInteger(screenId) || pageId !== 'screen' || typeof autoStart !== 'boolean') return error(422, 'Выберите экран GMIB');
    await output.start({screenId, pageId, autoStart});
    return http.response(200, {status: await output.getStatus()});
  }));
  http.delete('/output', route(async () => { await output.stop(); return http.response(200, {status: await output.getStatus()}); }));
};
