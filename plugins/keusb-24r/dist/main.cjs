'use strict';
const { randomUUID } = require('node:crypto');
const protocol = require('../lib/protocol.cjs');
const { validateOutputs, validateJob, validateRule, due, luxMatch } = require('../lib/automation.cjs');
exports.activate = async context => {
  if (!context.serial || !context.environment) throw new Error('Необходим GMIB Plugin API 1.3');
  const saved = await context.storage.get('state', {});
  const state = { mode: saved.mode === 'individual' ? 'individual' : 'group', jobs: saved.jobs || [], rules: saved.rules || [], logs: saved.logs || [], runs: saved.runs || {}, devices: saved.devices || [], environment: {} };
  const connections = new Map();
  const matches = new Map();
  let stopped = false;
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  state.devices.forEach(device => { device.connected = false; device.outputs = [null,null,null,null]; });
  const persist = async () => {
    state.logs = state.logs.filter(item => Date.parse(item.at) > Date.now() - 7*86400000).slice(-10000);
    const { environment, ...storedState } = state;
    await context.storage.set('state', storedState);
  };
  const log = (deviceId, source, outputs, message) => state.logs.push({ at: new Date().toISOString(), deviceId, source, outputs, message });
  const failDevice = async (device, error) => {
    matches.clear();
    device.connected = false; device.outputs = [null,null,null,null]; device.error = String(error.message || error);
    const connection = connections.get(device.id); connections.delete(device.id);
    if (connection) await connection.close();
    log(device.id, 'error', {}, device.error);
  };
  async function scan() {
    const ports = (await context.serial.list()).filter(p => p.vendorId?.toLowerCase() === '04d8' && p.productId?.toLowerCase() === '000a');
    for (const device of state.devices.filter(d => d.connected && !ports.some(p => p.path === d.path))) await failDevice(device, new Error('Устройство отключено'));
    for (const port of ports) {
      if (state.devices.some(device => device.connected && device.path === port.path)) continue;
      let connection;
      try {
        connection = await context.serial.open({ path: port.path, baudRate: 9600, vendorId: '04d8', productId: '000a' });
        const identity = await protocol.identify(connection);
        if (connections.has(identity.id)) throw new Error('Обнаружены одинаковые серийные номера; подключите устройства отдельно');
        const outputs = await protocol.read(connection);
        let device = state.devices.find(d => d.id === identity.id);
        if (!device) { device = { id: identity.id, name: `KeUSB-24R · ${identity.id}` }; state.devices.push(device); }
        Object.assign(device, identity, { path: port.path, connected: true, outputs, error: null });
        connections.set(device.id, connection);
        log(device.id, 'connection', {}, 'Подключено');
      } catch (error) {
        if (connection) await connection.close();
        context.logger.warn(`KeUSB ${port.path}: ${error.message}`);
      }
    }
  }
  async function apply(target, rawOutputs, source) {
    const outputs = validateOutputs(rawOutputs);
    const devices = state.devices.filter(d => d.connected && (target === 'all' || d.id === target));
    if (!devices.length) throw new Error('Нет подключённых реле для выбранной цели');
    const errors = [];
    for (const device of devices) {
      try {
        const connection = connections.get(device.id);
        const before = await protocol.read(connection);
        for (const [channel, enabled] of Object.entries(outputs)) if (before[Number(channel)-1] !== enabled) {
          await protocol.set(connection, Number(channel), enabled);

        }
        device.outputs = await protocol.read(connection);
        if (Object.entries(outputs).some(([channel,value]) => device.outputs[Number(channel)-1] !== value)) throw new Error('Проверка состояния после команды не совпала');
        for (const [channel, enabled] of Object.entries(outputs)) if (before[Number(channel)-1] !== enabled) log(device.id,source,{[channel]:enabled},`Выход ${channel}: ${enabled ? 'включён' : 'выключен'}`);
      } catch (error) { errors.push(`${device.id}: ${error.message}`); await failDevice(device,error); }
    }
    await persist();
    if (errors.length) throw new Error(errors.join('; '));
  }
  async function tick() {
    if (stopped) return;
    await scan();
    state.environment = await context.environment.snapshot();
    for (const device of state.devices.filter(d => d.connected)) {
      try {
        const outputs = await protocol.read(connections.get(device.id));
        if (JSON.stringify(outputs) !== JSON.stringify(device.outputs)) log(device.id,'external',Object.fromEntries(outputs.map((value,i)=>[i+1,value])),'Состояние изменилось');
        device.outputs = outputs;
      } catch(error) { await failDevice(device,error); }
    }
    for (const job of state.jobs) {
      const key = due(job,Date.now(),state.environment,state.runs[job.id]);
      if (!key) continue;
      state.runs[job.id] = key;
      if (job.kind === 'once') job.enabled = false;
      await persist(); // Record BEFORE hardware actions: never replay an uncertain write after restart.
      try { await apply(job.target,job.outputs,`job:${job.name}`); } catch(error) { log(job.target,'error',{},error.message); }
    }
    for (const rule of state.rules) {
      if (!rule.enabled) continue;
      const previous = matches.get(rule.id) || false;
      const matched = luxMatch(rule,state.environment.sensors?.find(s=>s.id===rule.sensorId),previous);
      if (matched === null) continue;
      if (!matched) { matches.set(rule.id,false); continue; }
      if (!previous) {
        try { await apply(rule.target,rule.outputs,`lux:${rule.name}`); matches.set(rule.id,true); } catch(error) { log(rule.target,'error',{},error.message); }
      }
    }
    await persist();
  }
  const route = (method,path,fn) => ['local','authenticated'].forEach(access => context.http[method](`/${path}`,request => serial(async () => {
    try { const result = await fn(request.body || {}); return context.http.response(200,result ?? {ok:true}); }
    catch(error) { return context.http.response(400,{error:error.message}); }
  }),{access}));
  route('get','state',() => ({ ...state, runs: undefined }));
  route('post','mode',async body => { if (!['group','individual'].includes(body.mode)) throw new Error('Некорректный режим'); state.mode=body.mode; await persist(); });
  route('post','outputs',body => apply(body.target,body.outputs,'manual'));
  for (const [collection,validate] of [['jobs',validateJob],['rules',validateRule]]) {
    route('put',collection,async body => {
      const input = body[collection === 'jobs' ? 'job' : 'rule'];
      const item = validate({...input,id:input?.id || randomUUID()});
      const index = state[collection].findIndex(existing=>existing.id===item.id);
      if (index === -1) { if(state[collection].length>=200) throw new Error('Не более 200 заданий'); state[collection].push(item); }
      else state[collection][index]=item;
      matches.delete(item.id);
      await persist(); return item;
    });
    route('delete',collection,async body => { state[collection]=state[collection].filter(item=>item.id!==body.id); delete state.runs[body.id]; matches.delete(body.id); await persist(); });
  }
  let timer;
  async function loop() {
    try { await serial(tick); } catch(error) { context.logger.warn(error.message); }
    if (!stopped) timer=setTimeout(loop,5000);
  }
  context.lifecycle.onDispose(async () => { stopped=true; clearTimeout(timer); await queue; await Promise.allSettled([...connections.values()].map(c=>c.close())); });
  void loop();
};
