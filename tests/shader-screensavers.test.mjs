import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHost } from './harness.mjs';

const require = createRequire(import.meta.url);
const { activate } = require('../plugins/shader-screensavers/dist/main.cjs');

const settingsKeys = [
  'scene',
  'speed',
  'scale',
  'brightness',
  'patternOpacity',
  'backgroundOpacity',
  'colorA',
  'colorB',
  'background',
  'animate',
];

const bodyOf = response =>
  response && Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : response;

const createShaderHost = async () => {
  const host = createHost();
  let state;
  let updateCalls = 0;
  const registrations = [];
  const stored = value => (value === undefined ? undefined : structuredClone(value));
  const baseHttp = host.context.http;
  for (const method of ['get', 'patch', 'put']) {
    const register = baseHttp[method];
    host.context.http[method] = (path, handler, options) => {
      registrations.push({ method: method.toUpperCase(), path, options });
      return register(path, handler, options);
    };
  }
  host.context.storage = {
    get: async (key, fallback) => stored(state === undefined ? fallback : state),
    set: async (key, value) => {
      state = stored(value);
    },
    update: async (key, updater) => {
      updateCalls++;
      state = stored(updater(stored(state)));
      return stored(state);
    },
  };
  await activate(host.context);
  return {
    host,
    registrations,
    getState: () => stored(state),
    getUpdateCalls: () => updateCalls,
  };
};

test('shader settings expose authenticated strict partial configuration and preserve local state UI', async () => {
  const { host, registrations, getState, getUpdateCalls } = await createShaderHost();
  try {
    assert.deepEqual(
      registrations
        .filter(route => route.path === '/settings')
        .map(route => ({ method: route.method, access: route.options?.access })),
      [
        { method: 'GET', access: 'authenticated' },
        { method: 'PATCH', access: 'authenticated' },
      ],
    );
    assert.equal(
      registrations.find(route => route.path === '/openapi.json' && route.method === 'GET').options
        ?.access,
      'authenticated',
    );
    const pluginSchema = bodyOf(await host.request('GET', '/openapi.json'));
    assert.equal(pluginSchema.openapi, '3.1.1');
    assert.deepEqual(pluginSchema.security, [
      { LocalBearer: [] },
      { HmacIdentifier: [], HmacTimestamp: [], HmacSignature: [] },
    ]);
    assert.deepEqual(Object.keys(pluginSchema.components.securitySchemes).sort(), [
      'HmacIdentifier',
      'HmacSignature',
      'HmacTimestamp',
      'LocalBearer',
    ]);
    assert.deepEqual(Object.keys(pluginSchema.paths).sort(), ['/openapi.json', '/settings']);
    assert.ok(pluginSchema.paths['/settings'].patch);
    assert.equal(
      registrations.find(route => route.path === '/state' && route.method === 'GET').options,
      undefined,
    );

    const initial = bodyOf(await host.request('GET', '/settings'));
    assert.deepEqual(Object.keys(initial).sort(), [...settingsKeys].sort());
    assert.equal(initial.scene, 'truchet');
    assert.equal(initial.speed, 45);

    const first = bodyOf(
      await host.request('PATCH', '/settings', {
        scene: 'aurora',
        speed: 62,
        scale: 44,
        brightness: 70,
        patternOpacity: 33,
        backgroundOpacity: 66,
        colorA: '#ABCDEF',
        colorB: '#012345',
        background: '#102030',
        animate: false,
      }),
    );
    assert.equal(first.changed, true);
    assert.equal(first.settings.scene, 'aurora');
    assert.equal(first.settings.speed, 62);
    assert.equal(first.settings.scale, 44);
    assert.equal(first.settings.brightness, 70);
    assert.equal(first.settings.patternOpacity, 33);
    assert.equal(first.settings.backgroundOpacity, 66);
    assert.equal(first.settings.colorA, '#abcdef');
    assert.equal(first.settings.colorB, '#012345');
    assert.equal(first.settings.background, '#102030');
    assert.equal(first.settings.animate, false);
    assert.deepEqual(Object.keys(first.settings).sort(), [...settingsKeys].sort());

    const repeat = bodyOf(
      await host.request('PATCH', '/settings', {
        scene: 'aurora',
        speed: 62,
        scale: 44,
        brightness: 70,
        patternOpacity: 33,
        backgroundOpacity: 66,
        colorA: '#abcdef',
        colorB: '#012345',
        background: '#102030',
        animate: false,
      }),
    );
    assert.equal(repeat.changed, false);
    assert.deepEqual(repeat.settings, first.settings);
    assert.equal(host.published.length, 1);

    const partial = bodyOf(
      await host.request('PATCH', '/settings', {
        brightness: 75,
      }),
    );
    assert.equal(partial.changed, true);
    assert.equal(partial.settings.speed, 62);
    assert.equal(partial.settings.brightness, 75);

    const empty = bodyOf(await host.request('PATCH', '/settings', {}));
    assert.equal(empty.changed, false);
    assert.equal(empty.settings.brightness, 75);

    for (const invalid of [
      { unknown: true },
      { scene: 'invalid' },
      { speed: 1.5 },
      { brightness: 4 },
      { patternOpacity: 101 },
      { colorB: '#abcd' },
      { animate: 'true' },
    ]) {
      const response = await host.request('PATCH', '/settings', invalid);
      assert.equal(response.status, 400);
      assert.equal(response.body.field, Object.keys(invalid)[0]);
      assert.equal(typeof response.body.error, 'string');
    }
    assert.equal(getUpdateCalls(), 4);

    const [speed, scale] = await Promise.all([
      host.request('PATCH', '/settings', { speed: 10 }),
      host.request('PATCH', '/settings', { scale: 90 }),
    ]);
    assert.equal(bodyOf(speed).changed, true);
    assert.equal(bodyOf(scale).changed, true);
    const merged = bodyOf(await host.request('GET', '/settings'));
    assert.equal(merged.speed, 10);
    assert.equal(merged.scale, 90);
    const persisted = getState();
    assert.equal(persisted.speed, 10);
    assert.equal(persisted.scale, 90);
    assert.equal(persisted.colorA, '#abcdef');
    assert.equal(getUpdateCalls(), 6);
  } finally {
    await host.close();
  }
});

test('shader local /state route keeps its existing normalization contract', async () => {
  const { host, registrations } = await createShaderHost();
  try {
    const localPut = bodyOf(
      await host.request('PUT', '/state', {
        scene: 'aurora',
        speed: 'not-a-number',
      }),
    );
    assert.equal(localPut.scene, 'aurora');
    assert.equal(localPut.speed, 45);
    assert.equal(bodyOf(await host.request('GET', '/state')).scene, 'aurora');
    assert.equal(
      registrations.find(route => route.path === '/state' && route.method === 'PUT').options,
      undefined,
    );
  } finally {
    await host.close();
  }
});
