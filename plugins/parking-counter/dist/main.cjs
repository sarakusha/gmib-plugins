'use strict';

const normalizeSpaces = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
};

exports.activate = async ({ events, http, storage }) => {
  const initial = await storage.get('spaces');
  if (!Number.isFinite(initial)) await storage.set('spaces', 100);

  const publish = spaces => {
    events.publish('changed', { spaces });
    return { spaces };
  };

  http.get('/state', async () => ({
    spaces: normalizeSpaces(await storage.get('spaces', 100)),
  }));

  http.post('/increment', async request => {
    const step = normalizeSpaces(request.body?.step ?? 1) || 1;
    return publish(await storage.update('spaces', value => normalizeSpaces(value) + step));
  });

  http.post('/decrement', async request => {
    const step = normalizeSpaces(request.body?.step ?? 1) || 1;
    return publish(
      await storage.update('spaces', value => Math.max(0, normalizeSpaces(value) - step)),
    );
  });

  http.put('/state', async request => {
    const spaces = normalizeSpaces(request.body?.spaces);
    await storage.set('spaces', spaces);
    return publish(spaces);
  });
};
