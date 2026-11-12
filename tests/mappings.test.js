'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {MappingManager} = require('../src/mappings');
const tick = () => new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const serial=(patch={})=>({kind:'serial',device:'/dev/cu.a',host:'ssh-target',name:'ttyA',baud:460800,dataBits:8,stopBits:1,parity:'none',flowControl:'none',...patch});
const probe=(patch={})=>({kind:'probe',probeUID:'DAP_001',host:'ssh-target',remotePort:5555,...patch});
class FakeBridge extends EventEmitter {
 constructor(plan={}){super();this.plan=plan;this.phase='idle';this.rxBytes=0;this.txBytes=0;this.startCalls=0;this.stopCalls=0;this.sent=[];}
 snapshot(){return {phase:this.phase,message:this.message||'',rxBytes:this.rxBytes,txBytes:this.txBytes,config:undefined};}
 async start(config){this.startCalls++;this.config=config;this.phase='starting';this.emit('snapshot');this.cancel=deferred();if(this.plan.startGate)await Promise.race([this.plan.startGate.promise,this.cancel.promise]);if(this.plan.failStart){this.phase='error';this.message='open failed';this.emit('snapshot');throw Error('open failed');}this.phase='connected';this.emit('snapshot');}
 async stop(){this.stopCalls++;if(this.phase==='starting')this.cancel?.reject(Error('stopped'));this.phase='stopping';this.emit('snapshot');if(this.plan.stopGate){this.closing=this.plan.stopGate.promise;await this.closing;this.closing=undefined;}if(this.plan.closeGate)await this.plan.closeGate.promise;if(this.plan.stopError)throw Error('cleanup failed');this.phase='idle';this.emit('snapshot');}
 send(...args){if(this.phase!=='connected')throw Error('offline');this.sent.push(args);this.txBytes+=Buffer.byteLength(args[0]);this.emit('snapshot');}
 receive(text){this.rxBytes+=Buffer.byteLength(text);this.emit('data',{type:'rx',data:Buffer.from(text).toString('base64')});this.emit('snapshot');}
}
function harness(configs=[]){const workers=[],plans=[];const manager=new MappingManager({configs,createBridge:config=>{const b=new FakeBridge(plans.shift());b.factoryConfig=config;workers.push(b);return b;}});return {manager,workers,plans};}

test('independent workers isolate data/counters and one stop leaves the other connected',async()=>{
 const {manager:m}=harness();const a=m.add(serial()),b=m.add(serial({device:'/dev/cu.b',name:'ttyB'}));const data=[];m.on('data',x=>data.push(x));await Promise.all([m.start(a),m.start(b)]);const first=m.get(a).bridge,second=m.get(b).bridge;first.receive('one');second.receive('second');m.send(a,'X',false,'none');assert.equal(m.list().find(x=>x.id===a).rxBytes,3);assert.equal(m.list().find(x=>x.id===b).rxBytes,6);assert.equal(m.list().find(x=>x.id===a).txBytes,1);assert.deepEqual(data.map(x=>x.id),[a,b]);await m.stop(a);assert.equal(second.phase,'connected');assert.throws(()=>m.send(a,'late'));assert.equal(first.sent.length,1);await m.stopAll();
});
test('drafts persist without auto-start and undefined snapshot config never overwrites them',async()=>{
 const saved=[{id:'saved',config:serial({device:'',baud:921600})}];const {manager:m,workers}=harness(saved);assert.equal(workers.every(x=>x.startCalls===0),true);assert.equal(m.list()[0].config.baud,921600);assert.equal(m.list()[0].config.device,'');assert.deepEqual(m.persisted(),saved);const draft=m.add({kind:'probe',probeUID:''});await assert.rejects(m.start(draft));assert.equal(m.get(draft).config.probeUID,'');await m.stopAll();
});
test('limit is eight and inactive removal frees a slot',async()=>{
 const {manager:m}=harness();const ids=Array.from({length:8},()=>m.add());assert.throws(()=>m.add(),/8|上限/);await m.remove(ids[2]);assert.equal(m.list().length,7);assert.equal(typeof m.add(),'string');assert.equal(m.list().length,8);await m.stopAll();
});
test('physical device reservations are synchronous across hosts while start is pending',async()=>{
 const h=harness(),m=h.manager;const a=m.add(serial()),b=m.add(serial({host:'other-host',name:'ttyB'}));const gate=deferred();h.plans.push({startGate:gate});const starting=m.start(a);await assert.rejects(m.start(b),/占用|使用|重复/);gate.resolve();await starting;await m.stopAll();
});
test('virtual serial names conflict only on the same host',async()=>{
 const {manager:m}=harness();const a=m.add(serial()),b=m.add(serial({device:'/dev/cu.b'}));await m.start(a);await assert.rejects(m.start(b),/占用|使用|重复/);await m.start(b,serial({device:'/dev/cu.b',host:'other-host'}));await m.stopAll();
});
test('probe UID and remote loopback port reservations are independent of serial channels',async()=>{
 const {manager:m}=harness();const a=m.add(probe()),sameProbe=m.add(probe({host:'other-host'})),samePort=m.add(probe({probeUID:'DAP_002'})),uart=m.add(serial());await m.start(a);await assert.rejects(m.start(sameProbe),/占用|使用|重复/);await assert.rejects(m.start(samePort),/占用|使用|重复/);await m.start(uart);assert.throws(()=>m.send(a,'no target writes'),/探针|probe|串口/);await m.stopAll();
});
test('probe start validates complete IDs/host/port while draft creation stays permissive',async()=>{
 const {manager:m}=harness();const id=m.add({kind:'probe'});for(const patch of [{probeUID:''},{probeUID:'bad\nUID'},{host:'-oProxyCommand=x'},{remotePort:1023},{remotePort:65536},{remotePort:5555.5}])await assert.rejects(m.start(id,probe(patch)));assert.deepEqual(m.get(id).config,{kind:'probe'});await m.start(id,probe());assert.equal(m.get(id).config.remotePort,5555);await m.stopAll();
});
test('failed start holds reservations until cleanup finishes then permits another channel',async()=>{
 const h=harness(),m=h.manager;const a=m.add(serial()),b=m.add(serial({host:'other-host'})),gate=deferred();h.plans.push({failStart:true,stopGate:gate});const failed=m.start(a);const outcome=failed.then(()=>null,e=>e);await tick();await assert.rejects(m.start(b),/占用|使用|重复/);const before=h.workers.length;const retry=m.start(a);await assert.rejects(retry);assert.equal(h.workers.length,before);gate.resolve();assert.match((await outcome).message,/open failed/);await m.start(b);await m.stopAll();
});
test('restart builds a fresh configured worker only after old closing has completed',async()=>{
 const h=harness(),m=h.manager;const a=m.add(serial());await m.start(a);const old=m.get(a).bridge;const gate=deferred();old.plan.stopGate=gate;const stopping=m.stop(a);const restarting=m.start(a,serial({baud:921600}));await tick();assert.equal(m.get(a).bridge,old);gate.resolve();await Promise.all([stopping,restarting]);const fresh=m.get(a).bridge;assert.notEqual(fresh,old);assert.equal(fresh.phase,'connected');assert.equal(fresh.config.baud,921600);assert.equal(m.list().find(x=>x.id===a).config.baud,921600);old.receive('stale');assert.equal(m.list().find(x=>x.id===a).rxBytes,0);await m.stopAll();
});
test('stop cancels a pending start; newer start survives the older stop completion',async()=>{
 const h=harness(),m=h.manager;const a=m.add(serial()),startGate=deferred(),stopGate=deferred();h.plans.push({startGate,stopGate});const opening=m.start(a);const cancelled=opening.then(()=>null,e=>e);await tick();const stopping=m.stop(a);const restarting=m.start(a,serial({baud:230400}));await tick();stopGate.resolve();await stopping;assert.ok(await cancelled);await restarting;assert.equal(m.get(a).bridge.phase,'connected');assert.equal(m.get(a).config.baud,230400);await m.stopAll();
});
test('remove rejects active and pending channels, then removes after awaited cleanup',async()=>{
 const {manager:m}=harness();const id=m.add(serial());await m.start(id);await assert.rejects(m.remove(id),/停止|活动|运行/);const bridge=m.get(id).bridge,gate=deferred();bridge.plan.stopGate=gate;const stopping=m.stop(id);await assert.rejects(m.remove(id));gate.resolve();await stopping;await m.remove(id);assert.equal(m.list().length,0);assert.throws(()=>m.get(id));
});
test('stopAll starts every shutdown and awaits every worker before resolving',async()=>{
 const {manager:m}=harness();const ids=[m.add(serial()),m.add(serial({device:'/dev/cu.b',name:'ttyB'}))];await Promise.all(ids.map(id=>m.start(id)));const gates=ids.map(id=>{const gate=deferred();m.get(id).bridge.plan.stopGate=gate;return gate;});let finished=false;const closing=m.stopAll().then(()=>finished=true);await tick();assert.ok(ids.every(id=>m.get(id).bridge.stopCalls>=1));gates[0].resolve();await tick();assert.equal(finished,false);gates[1].resolve();await closing;assert.equal(finished,true);assert.ok(m.list().every(x=>x.phase==='idle'));
});

test('runtime failure keeps resources reserved until asynchronous cleanup completes',async()=>{
 const {manager:m}=harness();const a=m.add(serial()),b=m.add(serial({host:'other-host'}));await m.start(a);const old=m.get(a).bridge,gate=deferred();old.plan.closeGate=gate;old.closing=gate.promise;old.phase='error';old.message='peer lost';old.emit('snapshot');await tick();await assert.rejects(m.start(b),/占用|使用|重复/);assert.equal(m.list().find(x=>x.id===a).message,'peer lost');gate.resolve();await tick();await m.start(b);await m.stopAll();
});
test('failed cleanup keeps ownership and explicit stop can retry safely',async()=>{
 const {manager:m}=harness();const a=m.add(serial()),b=m.add(serial({host:'other-host'}));await m.start(a);const old=m.get(a).bridge;old.plan.stopError=true;await assert.rejects(m.stop(a),/cleanup failed/);await assert.rejects(m.start(b),/占用|使用|重复/);old.plan.stopError=false;await m.stop(a);await m.start(b);await m.stopAll();
});
test('stopAll awaits successful peers even when another cleanup fails',async()=>{
 const {manager:m}=harness();const a=m.add(serial()),b=m.add(serial({device:'/dev/cu.b',name:'ttyB'}));await Promise.all([m.start(a),m.start(b)]);m.get(a).bridge.plan.stopError=true;const gate=deferred();m.get(b).bridge.plan.stopGate=gate;let completed=false;const result=m.stopAll().then(()=>null,error=>{completed=true;return error;});await tick();assert.equal(completed,false);await assert.rejects(m.start(a));gate.resolve();assert.ok(await result instanceof AggregateError);m.get(a).bridge.plan.stopError=false;await m.stopAll();
});
test('stopAll blocks reentrant starts from snapshot listeners before shutdown begins',async()=>{
 const {manager:m}=harness();const id=m.add(serial());await m.start(id);let attempt,once=false;m.on('snapshot',rows=>{if(!once&&rows.some(row=>row.phase==='stopping')){once=true;attempt=m.start(id,serial({baud:921600})).then(()=>null,error=>error);}});await m.stopAll();const error=await attempt;await m.stopAll();assert.ok(error instanceof Error);assert.match(error.message,/停止/);assert.equal(m.get(id).config.baud,460800);
});
