'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {promisify}=require('node:util');
const {execFileSync}=require('node:child_process');
const extensionFile=path.resolve(__dirname,'../src/extension.js'),nativeRequire=createRequire(extensionFile);
function fixture({saved={},authority,sshConfig='',directory='~/.local/share/serialbridge',explicitDirectory=false}={}){
 const state=new Map(Object.entries(saved)),workers=[],handlers={},commands=new Map();let processCalls=0;
 class FakeBridge extends EventEmitter{
  constructor(){super();this.phase='idle';this.generation=0;workers.push(this);}
  snapshot(){return {phase:this.phase,message:'',rxBytes:0,txBytes:0};}
  async start(config){this.config=config;this.phase='connected';this.emit('snapshot');}
  async stop(){this.phase='idle';this.emit('snapshot');}
 }
 const disposable={dispose(){}};
 const execFile=()=>{throw Error('Use promisified fake execFile');};
 execFile[promisify.custom]=async(exe,args)=>{processCalls++;return {stdout:JSON.stringify(args.includes('--list')?[{device:'/dev/cu.fixture',label:'Test serial',vid:1234}]:[]),stderr:''};};
 const vscode={workspace:{workspaceFolders:authority?[{uri:{scheme:'vscode-remote',authority}}]:[],getConfiguration:()=>({get:key=>key==='remoteDirectory'?directory:'~/.local/share/serialbridge/venv/bin/python3',inspect:key=>key==='remoteDirectory'?{defaultValue:'~/.local/share/serialbridge',globalValue:explicitDirectory?directory:undefined}:undefined})},window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}}),registerWebviewViewProvider:(id,provider)=>{handlers.provider=provider;return disposable;}},commands:{registerCommand:(id,handler)=>{commands.set(id,handler);return disposable;}},StatusBarAlignment:{Left:1},env:{}};
 const mod={exports:{}};
 const requireForTest=name=>{
  if(name==='vscode')return vscode;
  if(name==='node:fs')return {...fs,readFileSync:(file,...args)=>String(file).endsWith('/.ssh/config')?sshConfig:fs.readFileSync(file,...args)};
  if(name==='node:os')return {homedir:()=>'/home/test-user'};
  if(name==='node:child_process')return {execFile};
  if(name==='./bridge')return {...nativeRequire(name),Bridge:FakeBridge};
  if(name==='./probe')return {ProbeBridge:FakeBridge};
  return nativeRequire(name);
 };
 vm.runInNewContext(fs.readFileSync(extensionFile,'utf8'),{require:requireForTest,module:mod,exports:mod.exports,Buffer,console,setInterval:()=>({unref(){}}),clearInterval, setTimeout,clearTimeout},{filename:extensionFile});
 const context={extensionPath:path.dirname(path.dirname(extensionFile)),extensionUri:{},subscriptions:[],workspaceState:{get:(key,fallback)=>state.has(key)?state.get(key):fallback,update:async(key,value)=>state.set(key,value)}};
 const api=mod.exports.activate(context);
 const view={options:{},html:'',postMessage(){},onDidReceiveMessage:handler=>{handlers.message=handler;return disposable;}};
 handlers.provider.resolveWebviewView({webview:view,onDidDispose(){}});
 return {api,state,workers,handlers,vscode,get processCalls(){return processCalls;}};
}
const configOf=f=>f.api.snapshot().mappings[0].config;
test('new installs use generic defaults and current SSH workspace alias first',async()=>{
 const f=fixture({authority:'ssh-remote+workspace-target',sshConfig:'Host ssh-target backup-target\n  HostName example.invalid\nHost *\n'});
 const c=configOf(f);assert.equal(c.host,'workspace-target');assert.equal(c.name,'ttyBoard');assert.equal(c.baud,115200);assert.equal(c.remoteDirectory,'~/.local/share/serialbridge');assert.equal(c.device,'');assert.deepEqual(Array.from(f.api.snapshot().hosts),['workspace-target','ssh-target','backup-target']);assert.equal(f.processCalls,0);assert.ok(f.workers.every(x=>x.phase==='idle'));await f.api.stop();
});
test('without a remote workspace first safe SSH alias wins, with empty fallback',()=>{
 const a=fixture({sshConfig:'Host * !excluded\nHost ssh-target secondary # comment-not-an-alias\nHost -bad\n'});assert.equal(configOf(a).host,'ssh-target');assert.deepEqual(Array.from(a.api.snapshot().hosts),['ssh-target','secondary']);const b=fixture();assert.equal(configOf(b).host,'');assert.equal(b.api.snapshot().hosts.length,0);
});
test('saved 0.2.0 mappings keep host name baud and legacy log directory',()=>{
 const saved={mappings:[{id:'existing',config:{kind:'serial',device:'/dev/cu.fixture',host:'ssh-target',name:'ttyT3',baud:460800,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}},{id:'probe',config:{kind:'probe',host:'ssh-target',probeUID:'FAKE_PROBE_001',remotePort:5555}}],selectedId:'existing'};
 const f=fixture({saved,authority:'ssh-remote+different-target'});const c=configOf(f);assert.equal(c.host,'ssh-target');assert.equal(c.name,'ttyT3');assert.equal(c.baud,460800);assert.equal(c.device,'/dev/cu.fixture');assert.equal(c.remoteDirectory,'/workspace/.serial-logs');assert.equal(f.api.snapshot().mappings[1].config.remoteDirectory,'/workspace/.serial-logs');assert.equal(f.api.snapshot().selectedId,'existing');assert.equal(f.processCalls,0);
});
test('legacy single config migrates without changing established connection parameters',()=>{
 const f=fixture({saved:{config:{host:'ssh-target',name:'ttyExisting',baud:460800,device:'/dev/cu.fixture'}},directory:'~/.local/share/serialbridge-new'});const c=configOf(f);assert.equal(c.host,'ssh-target');assert.equal(c.name,'ttyExisting');assert.equal(c.baud,460800);assert.equal(c.remoteDirectory,'/workspace/.serial-logs');
});
test('previous custom directories survive reload and new channels use machine setting',async()=>{
 const f=fixture({saved:{mappings:[{id:'existing',config:{host:'ssh-target',name:'ttyExisting',baud:460800,remoteDirectory:'/srv/own logs'}}]},directory:'~/.local/share/new-runtime',sshConfig:'Host ssh-target'});assert.equal(configOf(f).remoteDirectory,'/srv/own logs');await f.handlers.message({command:'add'});const added=f.api.snapshot().mappings[1].config;assert.equal(added.name,'ttyBoard');assert.equal(added.baud,115200);assert.equal(added.remoteDirectory,'~/.local/share/new-runtime');await f.handlers.message({command:'add'});assert.equal(f.api.snapshot().mappings[2].config.name,'ttyBoard2');
});
test('hidden runtime directory cannot be overwritten by a stale webview config',async()=>{
 const f=fixture({saved:{mappings:[{id:'existing',config:{kind:'serial',device:'/dev/cu.fixture',host:'ssh-target',name:'ttyExisting',baud:460800,dataBits:8,stopBits:1,parity:'none',flowControl:'none',remoteDirectory:'/srv/own logs'}}]}});await f.handlers.message({command:'refresh'});const row=f.api.snapshot().mappings[0];const {remoteDirectory,...webviewConfig}=row.config;await f.handlers.message({command:'start',mappingId:row.id,session:row.session,config:webviewConfig});assert.equal(f.workers.at(-1).config.remoteDirectory,'/srv/own logs');assert.equal(f.workers.at(-1).config.baud,460800);await f.api.stop();
});
test('explicit machine directory setting applies on manual start, without auto start',async()=>{
 const f=fixture({saved:{mappings:[{id:'existing',config:{kind:'serial',device:'/dev/cu.fixture',host:'ssh-target',name:'ttyExisting',baud:460800,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}}]},directory:'~/custom runtime',explicitDirectory:true});assert.equal(configOf(f).remoteDirectory,'/workspace/.serial-logs');await f.handlers.message({command:'refresh'});const row=f.api.snapshot().mappings[0];await f.handlers.message({command:'start',mappingId:row.id,session:row.session,config:row.config});assert.equal(f.workers.at(-1).config.remoteDirectory,'~/custom runtime');await f.api.stop();
});
test('serial remote directory is shell quoted as one literal argument',()=>{
 const {remoteCommand,validateConfig}=require('../src/bridge');const directory="~/serial logs/it's $(printf unsafe)";const config={device:'/dev/cu.fixture',host:'ssh-target',name:'ttyBoard',baud:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',remoteDirectory:directory};const source='import json,sys; print(json.dumps(sys.argv[1:]))';const command=remoteCommand(source,validateConfig(config));const args=JSON.parse(execFileSync('/bin/sh',['-c',command],{encoding:'utf8'}));assert.equal(args[args.indexOf('--directory')+1],directory);assert.equal(args[args.indexOf('--name')+1],'ttyBoard');assert.throws(()=>validateConfig({...config,remoteDirectory:'/tmp/bad\npath'}));
});
test('public manifest and empty UI defaults are portable',()=>{
 const manifest=require('../package.json');assert.equal(manifest.repository.url,'https://github.com/MScorpioLee/vscode-serial-bridge.git');assert.equal(manifest.contributes.configuration.properties['serialBridge.remoteDirectory'].default,'~/.local/share/serialbridge');const markup=require('../src/panel').html({},{});assert.match(markup,/host:'',name:'ttyBoard',baud:115200/);assert.ok(markup.includes('芯片烧录和调试由远端工具操作'));assert.match(markup,/<option value="">选择 SSH 主机/);assert.match(markup,/id="name" value="ttyBoard"/);
});
