'use strict';
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {validateConfig} = require('./bridge');
const ACTIVE = new Set(['starting', 'connected', 'stopping']);

function copyConfig(config = {}) {
 if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('映射配置无效');
 return {...config};
}
function validateMapping(config) {
 const c = copyConfig(config), kind = c.kind || 'serial';
 if (kind === 'serial') return {...validateConfig(c), kind};
 if (kind !== 'probe') throw Error('映射类型无效');
 if (typeof c.probeUID !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(c.probeUID)) throw Error('请选择有效的 CMSIS-DAP 探针');
 if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(c.host || '')) throw Error('SSH 主机名称无效');
 const port = Number(c.remotePort);
 if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('探针远端端口应为 1024–65535');
 return {...c, kind, remotePort:port};
}
function resourceKeys(config) {
 return config.kind === 'probe'
  ? ['probe:'+config.probeUID, 'probe-endpoint:'+JSON.stringify([config.host, config.remotePort])]
  : ['serial:'+config.device, 'serial-endpoint:'+JSON.stringify([config.host, config.name])];
}

class MappingManager extends EventEmitter {
 constructor({createBridge, configs = [], maxMappings = 8} = {}) {
  super();
  if (typeof createBridge !== 'function') throw Error('createBridge is required');
  if (!Number.isInteger(maxMappings) || maxMappings < 1 || maxMappings > 8) throw Error('映射上限应为 1–8');
  if (!Array.isArray(configs) || configs.length > maxMappings) throw Error('最多支持 '+maxMappings+' 个独立映射');
  this.createBridge = createBridge;
  this.maxMappings = maxMappings;
  this.entries = new Map();
  this.reservations = new Map();
  this.stopAllTask = null;
  for (const saved of configs) {
   if (!saved || typeof saved.id !== 'string' || !saved.id || this.entries.has(saved.id)) throw Error('已保存映射编号无效或重复');
   this.insert(saved.id, copyConfig(saved.config));
  }
 }
 insert(id, config) {
  const entry = {id, config, bridge:null, worker:null, version:0, intent:null, starts:new Set(), stopTask:null, removing:false};
  entry.worker = this.makeRecord(entry, config, 0);
  entry.bridge = entry.worker.bridge;
  this.entries.set(id, entry);
  return entry;
 }
 makeRecord(entry, config, version) {
  const bridge = this.createBridge(copyConfig(config));
  if (!bridge || !['on','snapshot','start','stop'].every(key => typeof bridge[key] === 'function')) throw Error('映射控制器无效');
  const record = {bridge, version, claim:null, closeTask:null, closed:false, failure:null};
  bridge.on('snapshot', () => {
   if (this.entries.get(entry.id) !== entry || entry.worker !== record) return;
   const snapshot = bridge.snapshot();
   if (snapshot.phase === 'error') {
    record.failure = snapshot.message || '映射连接失败';
    // Bridge emits its error before installing its own asynchronous closing task.
    // Wait one microtask, then join shutdown before releasing any resource claim.
    if (record.claim) void Promise.resolve().then(() => this.closeRecord(record)).then(() => this.update(), () => this.update());
   }
   this.update();
  });
  bridge.on('data', value => {
   if (this.entries.get(entry.id) === entry && entry.worker === record && entry.version === record.version && entry.intent !== 'stop' && bridge.snapshot().phase === 'connected') {
    this.emit('data', {...value, id:entry.id});
   }
  });
  return record;
 }
 get(id) {
  const entry = this.entries.get(id);
  if (!entry) throw Error('映射不存在');
  return entry;
 }
 list() {
  return [...this.entries.values()].map(entry => {
   const snapshot = entry.bridge.snapshot();
   const result = {...snapshot, id:entry.id, config:copyConfig(entry.config)};
   if (entry.intent === 'start') {result.phase='starting';result.message='正在准备独立映射…';}
   else if (entry.intent === 'stop' || entry.removing) {result.phase='stopping';result.message='正在停止映射…';}
   else if (entry.worker.failure) {result.phase='error';result.message=entry.worker.failure;}
   return result;
  });
 }
 update() {this.emit('snapshot', this.list());}
 add(config = {}) {
  if (this.entries.size >= this.maxMappings) throw Error('最多支持 '+this.maxMappings+' 个独立映射');
  const id = randomUUID();
  this.insert(id, copyConfig(config));
  this.update();
  return id;
 }
 reserve(entry, keys) {
  for (const key of keys) {
   const existing = this.reservations.get(key);
   if (existing && existing.id !== entry.id) throw Error('该设备或远端名称已被其他映射占用');
  }
  const claim = {id:entry.id, keys, token:Symbol(entry.id), released:false};
  for (const key of keys) {
   if (!this.reservations.has(key)) this.reservations.set(key, {id:entry.id, tokens:new Set()});
   this.reservations.get(key).tokens.add(claim.token);
  }
  return claim;
 }
 release(claim) {
  if (!claim || claim.released) return;
  for (const key of claim.keys) {
   const owner = this.reservations.get(key);
   if (owner?.id === claim.id) {
    owner.tokens.delete(claim.token);
    if (!owner.tokens.size) this.reservations.delete(key);
   }
  }
  claim.released = true;
 }
 closeRecord(record) {
  if (!record || record.closed) return Promise.resolve();
  if (record.closeTask) return record.closeTask;
  record.closeTask = Promise.resolve().then(async () => {
   try {
    await record.bridge.stop();
    if (record.bridge.closing) await record.bridge.closing;
    record.closed = true;
    this.release(record.claim);
   } catch (error) {
    // A failed cleanup is not evidence that its child processes released the port.
    // Keep the claim and allow a later explicit stop to retry cleanup.
    if (record.bridge.closing) await record.bridge.closing;
    throw error;
   }
  });
  void record.closeTask.catch(() => {record.closeTask=null;});
  return record.closeTask;
 }
 async start(id, input) {
  const entry = this.get(id);
  if (this.stopAllTask || entry.removing) throw Error('正在停止映射，请稍后重试');
  if (entry.intent === 'start' || (ACTIVE.has(entry.bridge.snapshot().phase) && entry.intent !== 'stop')) throw Error('映射已启动或正在清理，请先停止');
  const config = validateMapping(input === undefined ? entry.config : input);
  // Claim both resources before the first await: separate starts cannot race here.
  const claim = this.reserve(entry, resourceKeys(config));
  const version = ++entry.version, previousStop = entry.stopTask;
  entry.intent = 'start';
  entry.config = config;
  let worker;
  const task = (async () => {
   try {
    if (previousStop) await previousStop;
    await this.closeRecord(entry.worker);
    if (entry.version !== version || entry.removing) throw Error('映射已停止');
    worker = this.makeRecord(entry, config, version);
    worker.claim = claim;
    entry.worker = worker;
    entry.bridge = worker.bridge;
    await worker.bridge.start(copyConfig(config));
    if (entry.version !== version || entry.removing) throw Error('映射已停止');
   } catch (error) {
    if (worker) {
     worker.failure = worker.failure || error.message;
     // Await actual shutdown before the original start failure or a retry is exposed.
     await this.closeRecord(worker);
    } else {
     this.release(claim);
    }
    throw error;
   } finally {
    if (entry.version === version) entry.intent = null;
    this.update();
   }
  })();
  entry.starts.add(task);
  this.update();
  try {await task;} finally {entry.starts.delete(task);}
 }
 async stop(id) {
  const entry = this.get(id);
  if (entry.intent === 'stop' && entry.stopTask) return entry.stopTask;
  const version = ++entry.version, worker = entry.worker;
  const starts = [...entry.starts];
  entry.intent = 'stop';
  const task = (async () => {
   try {
    await this.closeRecord(worker);
    await Promise.allSettled(starts);
    if (entry.version === version) {
     entry.intent = null;
     worker.failure = null;
    }
   } finally {
    if (entry.version === version && entry.intent === 'stop') entry.intent = null;
    this.update();
   }
  })();
  entry.stopTask = task;
  this.update();
  try {await task;} finally {if (entry.stopTask === task) entry.stopTask=null;}
 }
 async remove(id) {
  const entry = this.get(id);
  if (entry.intent || entry.removing || ACTIVE.has(entry.bridge.snapshot().phase)) throw Error('请先停止活动映射再移除');
  entry.removing = true;
  ++entry.version;
  try {
   await this.closeRecord(entry.worker);
   this.entries.delete(id);
  } finally {
   entry.removing = false;
   this.update();
  }
 }
 send(id, text, hex, newline) {
  const entry = this.get(id);
  if (entry.config.kind === 'probe') throw Error('探针通道不支持串口发送');
  if (entry.intent || entry.removing || entry.bridge.snapshot().phase !== 'connected') throw Error('请先启动映射');
  if (typeof entry.bridge.send !== 'function') throw Error('当前通道不支持发送');
  return entry.bridge.send(text, hex, newline);
 }
 async stopAll() {
  if (this.stopAllTask) return this.stopAllTask;
  const task = Promise.resolve().then(() => Promise.allSettled([...this.entries.keys()].map(id => this.stop(id)))).then(results => {
   const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
   if (failures.length) throw new AggregateError(failures, '部分映射尚未完成停止');
  });
  this.stopAllTask = task;
  try {await task;} finally {if (this.stopAllTask === task) this.stopAllTask=null;}
 }
 persisted() {return [...this.entries.values()].map(entry => ({id:entry.id, config:copyConfig(entry.config)}));}
}
module.exports = {MappingManager};
