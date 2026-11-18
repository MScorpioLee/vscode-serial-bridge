'use strict';
// Test fixture only: real controllers/helpers, simulated PTYs, and no SSH process.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const root = process.env.SERIALBRIDGE_PRESSURE_SOURCE_ROOT || path.resolve(__dirname, '..');
const {Bridge} = require(path.join(root, 'src/bridge'));
const {MappingManager} = require(path.join(root, 'src/mappings'));
const python = process.env.BRIDGE_PYTHON;
const runtime = process.env.BRIDGE_RUNTIME;
const ports = JSON.parse(process.env.BRIDGE_PORTS || '[]');
if (process.env.SERIALBRIDGE_SIMULATED_PTY !== '1' || !python || ports.length !== 2 ||
    !ports.every(port => /^\/dev\/(?:ttys\d+|pts\/\d+)$/.test(port)) ||
    !path.basename(runtime || '').startsWith('serialbridge-pressure-') ||
    fs.realpathSync(path.dirname(runtime)) !== fs.realpathSync(os.tmpdir())) {
 throw Error('Only two test-created PTYs and a private temporary runtime are permitted');
}
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const children = [];
const holderScript = [
 'import os, subprocess, sys',
 'p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdin=subprocess.DEVNULL)',
 'os.write(2, ("PRESSURE_HOLDER_PID=" + str(p.pid) + "\\n").encode())',
 'os.execv(sys.executable, [sys.executable] + sys.argv[1:])',
].join('\n');
const manager = new MappingManager({createBridge: config => new Bridge({
 root, python,
 spawn: (exe, args, options) => {
  const role = exe === '/usr/bin/ssh' ? 'remote' : 'local';
  if (role === 'remote') {
   args = ['-u', path.join(root, 'helpers/remote_bridge.py'), '--directory', runtime,
    '--name', config.name, '--baud', String(config.baud)];
   if (process.env.BRIDGE_HOLD_REMOTE_PIPE === '1' && config.name === 'ttyPressureA') {
    args = ['-c', holderScript, ...args];
   }
   exe = python;
  } else if (exe !== python) throw Error('Unexpected test executable');
  const child = cp.spawn(exe, args, options);
  const record = {name:config.name, role, pid:child.pid, exited:false, closed:false, holders:[]};
  children.push(record);
  let stderr = '';
  child.stderr.on('data', chunk => {
   stderr = (stderr + chunk).slice(-4000);
   for (const match of stderr.matchAll(/PRESSURE_HOLDER_PID=(\d+)/g)) {
    const pid = Number(match[1]);
    if (!record.holders.includes(pid)) record.holders.push(pid);
   }
  });
  child.once('exit', (code, signal) => Object.assign(record, {exited:true, code, signal}));
  child.once('close', () => {record.closed = true;});
  return child;
 },
})});
const ids = ports.map((device, index) => manager.add({
 kind:'serial', device, host:'simulated-test-only', remoteDirectory:runtime,
 name:index ? 'ttyPressureB' : 'ttyPressureA', baud:115200,
 dataBits:8, stopBits:1, parity:'none', flowControl:'none',
}));
function state() {
 return {mappings:manager.list(), children:children.map(record => ({...record})),
  reservations:[...manager.reservations.keys()]};
}
function clearHolders() {
 for (const record of children) for (const pid of record.holders) {
  try {process.kill(pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
 }
}
let quitting = false;
async function quit(code = 0) {
 if (quitting) return;
 quitting = true;
 clearHolders();
 try {await manager.stopAll();} catch (error) {out({type:'error', message:error.message});code = 1;}
 process.stdout.write(JSON.stringify({type:'closed', ...state()}) + '\n', () => process.exit(code));
}
readline.createInterface({input:process.stdin}).on('line', line => {
 void (async () => {
  const request = JSON.parse(line), begin = performance.now();
  if (request.type === 'stop') await manager.stop(ids[request.index]);
  else if (request.type === 'start') await manager.start(ids[request.index]);
  else if (request.type === 'clearHolders') clearHolders();
  else if (request.type === 'quit') {await quit();return;}
  else if (request.type !== 'snapshot') throw Error('Unknown test command');
  out({type:'response', requestId:request.requestId, durationMs:performance.now()-begin, ...state()});
 })().catch(error => out({type:'error', message:error.message}));
}).on('close', () => void quit());
process.on('SIGTERM', () => void quit());
process.on('SIGINT', () => void quit());
Promise.all(ids.map(id => manager.start(id))).then(
 () => out({type:'ready', ...state()}),
 error => {out({type:'error', message:error.message});void quit(1);},
);
