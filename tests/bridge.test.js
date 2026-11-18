const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {Bridge, LineReader, validateConfig, encodeSend, remoteCommand} = require('../src/bridge');
function fake(){const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{c.emit('close',0)};c.stdin.on('finish',()=>setImmediate(()=>c.emit('close',0)));c.send=o=>c.stdout.write(JSON.stringify(o)+'\n');return c;}
const config={device:'/dev/cu.test',host:'ssh-target',name:'ttyBoard',baud:460800,dataBits:8,stopBits:1,parity:'none',flowControl:'none'};
test('config rejects command injection and invalid UART values',()=>{assert.equal(validateConfig(config).baud,460800);for(const patch of [{host:'-oProxyCommand=bad'},{name:'../bad'},{baud:0},{parity:'bad'},{device:'x\0bad'},{dataBits:9}])assert.throws(()=>validateConfig({...config,...patch}));});
test('binary send exact and text newline explicit',()=>{assert.deepEqual(encodeSend('00 ff 0A',true,'crlf'),Buffer.from([0,255,10]));assert.equal(encodeSend('你好',false,'crlf').toString(),'你好\r\n');assert.throws(()=>encodeSend('0',true,'none'));assert.throws(()=>encodeSend('gg',true,'none'));});
test('framing handles fragments and rejects oversized or malformed data',()=>{const got=[];const r=new LineReader(x=>got.push(x));r.push(Buffer.from('{"a":'));r.push(Buffer.from('1}\n{"b":2}\n'));assert.deepEqual(got,[{a:1},{b:2}]);assert.throws(()=>r.push(Buffer.from('not json\n')));assert.throws(()=>new LineReader(()=>{},32).push(Buffer.alloc(33,65)));});
test('remote source encoded and config never interpolated unquoted',()=>{const cmd=remoteCommand('print("x")',config);assert.ok(cmd.includes('base64'));assert.ok(cmd.includes('ttyBoard'));assert.ok(!cmd.includes('print("x")'));});
test('RX and TX route only after both helpers ready and stop rejects sends',async()=>{const children=[];const b=new Bridge({root:__dirname,python:'/python',remoteSource:'pass',spawn:()=>{const c=fake();children.push(c);return c;}});const opening=b.start(config);await new Promise(setImmediate);const remote=children[0];let remoteInput='';remote.stdin.on('data',x=>remoteInput+=x);remote.send({type:'ready',port:'/tmp/ttyBoard',log:'/tmp/log',status:'/tmp/status'});const local=children[1];assert.ok(local);let localInput='';local.stdin.on('data',x=>localInput+=x);remote.send({type:'write',data:'eA==',id:'early'});assert.equal(localInput,'');local.send({type:'ready'});await opening;local.send({type:'rx',data:Buffer.from([0,255,65]).toString('base64')});assert.ok(remoteInput.includes('AP9B'));remote.send({type:'write',data:'YWJj',id:'r1',last_heartbeat_id:[...b.heartbeats.keys()].at(-1)});assert.ok(localInput.includes('YWJj'));local.send({type:'tx',data:'YWJj',id:'r1'});assert.equal(b.snapshot().txBytes,3);assert.equal(b.snapshot().rxBytes,3);b.send('x',false,'none');await b.stop();assert.throws(()=>b.send('x',false,'none'));assert.equal(b.snapshot().phase,'idle');});
test('helper exit tears down peer and marks mapping offline',async()=>{const children=[];const b=new Bridge({root:__dirname,python:'/python',remoteSource:'pass',spawn:()=>{const c=fake();children.push(c);return c;}});const starting=b.start(config);await new Promise(setImmediate);children[0].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});children[1].send({type:'ready'});await starting;children[1].emit('close',1);await new Promise(r=>setTimeout(r,20));assert.equal(b.snapshot().phase,'error');assert.throws(()=>b.send('stale',false,'none'));});
test('old stop cannot overwrite a newly starting mapping',async()=>{const children=[];const b=new Bridge({root:__dirname,python:'/python',remoteSource:'pass',spawn:()=>{const c=fake();children.push(c);return c;}});const initial=b.start(config);await new Promise(setImmediate);children[0].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});children[1].send({type:'ready'});await initial;b.phase='error';const stopping=b.stop();const starting=b.start(config);await stopping;await new Promise(setImmediate);assert.equal(b.phase,'starting');children[2].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});children[3].send({type:'ready'});await starting;await b.stop();});
test('actual failed SSH close allows stop and another connection',async()=>{const cp=require('node:child_process');const b=new Bridge({root:__dirname,python:'/python',remoteSource:'pass',spawn:()=>cp.spawn(process.execPath,['-e','process.exit(9)'])});await assert.rejects(b.start(config));await Promise.race([b.stop(),new Promise((_,reject)=>setTimeout(()=>reject(Error('stop hung after child already closed')),200))]);assert.equal(b.phase,'idle');await assert.rejects(b.start(config));await b.stop();});
test('expired heartbeat never dispatches remote commands to the serial helper',async()=>{const children=[];const b=new Bridge({root:__dirname,python:'/python',remoteSource:'pass',spawn:()=>{const c=fake();children.push(c);return c;}});const opening=b.start(config);await new Promise(setImmediate);children[0].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});children[1].send({type:'ready'});await opening;let data='';children[1].stdin.on('data',x=>data+=x);const id=[...b.heartbeats.keys()].at(-1);b.heartbeats.set(id,Date.now()-10000);children[0].send({type:'write',id:'stale',data:'ZG9udCBzZW5k',last_heartbeat_id:id});assert.equal(b.phase,'error');assert.ok(!data.includes('ZG9udCBzZW5k'));await b.stop();});
test('text-mode managed process reads stderr readiness without JSON parsing',async()=>{const cp=require('node:child_process');const b=new Bridge({root:__dirname,python:'/python'});let seen='';const child=b.launch(process.execPath,['-e','console.error("Serving debug probe Test (123) on port 12345")'],'probe',x=>seen+=x,b.generation,{text:true});await child.bridgeClose;assert.match(seen,/Serving debug probe Test/);await b.stop();});

test('stop releases an exited helper even while a descendant holds its output pipe', {timeout:6000}, async t=>{
 const cp=require('node:child_process');
 const {MappingManager}=require('../src/mappings');
 const children=[],holders=[];let calls=0;
 const spawn=()=>{
  const local=++calls%2===0;
  const source=`const cp=require('node:child_process');
   ${local?`const held=cp.spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:['ignore',1,2]});process.stdout.write(JSON.stringify({type:'holder',pid:held.pid})+'\\n');`:''}
   process.stdout.write(JSON.stringify(${JSON.stringify(local?{type:'ready'}:{type:'ready',port:'/tmp/test-port',log:'/tmp/test-log',status:'/tmp/test-status'})})+'\\n');
   process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
  const child=cp.spawn(process.execPath,['-e',source]);children.push(child);
  const reader=new LineReader(message=>{if(message.type==='holder')holders.push(message.pid);});
  child.stdout.on('data',chunk=>reader.push(chunk));
  return child;
 };
 const manager=new MappingManager({createBridge:()=>new Bridge({root:__dirname,spawn,python:'unused',remoteSource:'unused'})});
 const id=manager.add({...config,kind:'serial'});
 let stopping;
 t.after(async()=>{
  for(const pid of holders)try{process.kill(pid,'SIGKILL');}catch{}
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await stopping?.catch(()=>{});
 });
 await manager.start(id);
 for(let i=0;i<100;i++)manager.send(id,'pending '.repeat(100),false,'none');
 const begin=Date.now();stopping=manager.stop(id);
 let timer;
 try{await Promise.race([stopping,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stop is still waiting for an exited helper output pipe')),1000);})]);}
 finally{clearTimeout(timer);}
 assert.ok(Date.now()-begin<1000);
 assert.equal(manager.list()[0].phase,'idle');
 assert.equal(manager.reservations.size,0);
 assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('stop publishes stopping immediately while helper cleanup is pending',async()=>{
 const children=[];
 const b=new Bridge({root:__dirname,python:'unused',remoteSource:'unused',spawn:()=>{const child=fake();children.push(child);return child;}});
 const opening=b.start(config);await new Promise(setImmediate);
 children[0].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});
 children[1].send({type:'ready'});await opening;
 const stopping=b.stop();
 assert.equal(b.snapshot().phase,'stopping');
 assert.throws(()=>b.send('must not enqueue after stop',false,'none'));
 await stopping;
});

test('stop discards backed-up writes instead of sending the full backlog during unbind',{timeout:6000},async t=>{
 const cp=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'serial-stop-backlog-'));
 const record=path.join(directory,'received.json');
 const children=[];let calls=0;
 const spawn=()=>{
  const local=++calls%2===0;
  const ready=JSON.stringify(local?{type:'ready'}:{type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});
  const source=local?`const fs=require('node:fs');let bytes=0;process.stdin.on('data',x=>bytes+=x.length);process.stdin.pause();
   process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({bytes}));process.exit(0);});
   setTimeout(()=>process.stdin.resume(),300);process.stdout.write(JSON.stringify(${ready})+'\\n');`
   :`process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write(JSON.stringify(${ready})+'\\n');`;
  const child=cp.spawn(process.execPath,['-e',source]);children.push(child);return child;
 };
 const b=new Bridge({root:__dirname,spawn,python:'unused',remoteSource:'unused'});
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await b.stop().catch(()=>{});fs.rmSync(directory,{recursive:true,force:true});});
 await b.start(config);
 for(let i=0;i<50;i++)try{b.send('x'.repeat(65536),false,'none');}catch{}
 assert.ok(b.localWriter.pending>1500000,'fixture must have a substantial pending backlog');
 await b.stop();
 const received=JSON.parse(fs.readFileSync(record,'utf8')).bytes;
 assert.ok(received<1500000,`stop delivered ${received} queued bytes instead of discarding the backlog`);
});

test('unconfirmed helper termination fails stop, keeps the resource claim, and allows a safe retry',async t=>{
 const {MappingManager}=require('../src/mappings');
 const children=[];let stuck=true;
 const manager=new MappingManager({createBridge:()=>new Bridge({root:__dirname,python:'unused',remoteSource:'unused',spawn:()=>{
  const child=fake();
  if(stuck){child.stdin.removeAllListeners('finish');child.kill=()=>{child.killed=true;return true;};}
  children.push(child);return child;
 }})});
 const first=manager.add({...config,kind:'serial'});
 const opening=manager.start(first);await new Promise(setImmediate);
 children[0].send({type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});
 children[1].send({type:'ready'});await opening;
 t.mock.timers.enable({apis:['setTimeout']});
 let result;
 const stopping=manager.stop(first).then(()=>{result={resolved:true};},error=>{result={error};});
 t.after(async()=>{
  for(const child of children){child.emit('exit',0);child.emit('close',0);}
  t.mock.timers.reset();await stopping;await manager.stopAll().catch(()=>{});
 });
 await new Promise(setImmediate);t.mock.timers.tick(10000);await new Promise(setImmediate);
 assert.ok(result?.error,'stop must report an unconfirmed termination instead of waiting forever');
 assert.equal(manager.list()[0].phase,'error');
 assert.equal(manager.list()[0].cleanupPending,true);
 assert.equal(manager.get(first).bridge.closing,undefined,'failed cleanup must be retryable');
 assert.equal(manager.get(first).bridge.children.length,2,'unconfirmed children must stay tracked');
 assert.equal(manager.reservations.size,2);
 const second=manager.add({...config,kind:'serial',host:'other-target'});
 await assert.rejects(manager.start(second),/占用/);
 for(const child of children){child.emit('exit',0);child.emit('close',0);}
 stuck=false;
 await manager.stop(first);
 assert.equal(manager.reservations.size,0);
 assert.equal(manager.list()[0].cleanupPending,false);
 await manager.remove(first);
 await manager.remove(second);
});

test('a real helper that ignores EOF and TERM is killed before stop succeeds',{timeout:6000},async t=>{
 const cp=require('node:child_process');const children=[];let calls=0;
 const b=new Bridge({root:__dirname,python:'unused',remoteSource:'unused',spawn:()=>{
  const ready=JSON.stringify(++calls%2===0?{type:'ready'}:{type:'ready',port:'/tmp/p',log:'/tmp/l',status:'/tmp/s'});
  const source=`process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);process.stdout.write(JSON.stringify(${ready})+'\\n');`;
  const child=cp.spawn(process.execPath,['-e',source]);children.push(child);return child;
 }});
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await b.stop().catch(()=>{});});
 await b.start(config);
 const began=Date.now();await b.stop();const elapsed=Date.now()-began;
 assert.ok(elapsed>=2600&&elapsed<4000,`TERM/KILL cleanup took ${elapsed} ms`);
 assert.ok(children.every(child=>child.signalCode==='SIGKILL'));
 assert.equal(b.snapshot().cleanupPending,false);
});

test('a real spawn failure has no live process to retain',{timeout:2000},async()=>{
 const cp=require('node:child_process');
 const b=new Bridge({root:__dirname,python:'unused',remoteSource:'unused',spawn:()=>cp.spawn('/serialbridge/nonexistent-test-helper',[])});
 await assert.rejects(b.start(config),/ENOENT/);
 await b.stop();
 assert.equal(b.snapshot().cleanupPending,false);
});

test('probe stop also releases its TCP listener while a descendant holds the output pipe',{timeout:6000},async t=>{
 const cp=require('node:child_process'),net=require('node:net');
 const {ProbeBridge}=require('../src/probe');
 const children=[],holders=[];let calls=0;
 const b=new ProbeBridge({root:__dirname,python:'unused',probeRemoteSource:'unused',spawn:(exe,args)=>{
  const local=++calls%2===1;
  const source=local?`const cp=require('node:child_process'),net=require('node:net');
   const held=cp.spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:['ignore',1,2]});process.stderr.write('holder '+held.pid+'\\n');
   net.createServer(s=>s.destroy()).listen(${Number(args[args.indexOf('--port')+1])},'127.0.0.1',()=>process.stderr.write('Serving debug probe Test (TEST_PROBE) on port '+${Number(args[args.indexOf('--port')+1])}+'\\n'));
   process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`
   :`process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write(JSON.stringify({type:'ready',port:'127.0.0.1:5555',endpoint:'remote:127.0.0.1:5555',status:'/tmp/probe-test.status.json'})+'\\n');`;
  const child=cp.spawn(process.execPath,['-e',source]);children.push(child);
  if(local){const reader=new LineReader(line=>{const match=/^holder (\d+)$/.exec(line);if(match)holders.push(Number(match[1]));},undefined,s=>s);child.stderr.on('data',x=>reader.push(x));}
  return child;
 }});
 t.after(async()=>{for(const pid of holders)try{process.kill(pid,'SIGKILL');}catch{}for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await b.stop().catch(()=>{});});
 await b.start({kind:'probe',probeUID:'TEST_PROBE',host:'ssh-target',remotePort:5555});
 const port=b.localPort,began=Date.now();await b.stop();
 assert.ok(Date.now()-began<1000);
 assert.equal(b.snapshot().cleanupPending,false);
 const listener=net.createServer();
 await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(port,'127.0.0.1',resolve);});
 await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
});
