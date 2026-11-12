'use strict';
const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const {Bridge,validateRemoteDirectory,DEFAULT_REMOTE_DIRECTORY,LEGACY_REMOTE_DIRECTORY}=require('./bridge');
const {ProbeBridge}=require('./probe');
const {MappingManager}=require('./mappings');
const {html}=require('./panel');
const {randomUUID}=require('node:crypto');
const {token,channelFor,captureProbes,applyProbePresence}=require('./channel_identity');
const DEFAULT={kind:'serial',device:'',host:'',name:'ttyBoard',baud:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',probeUID:'',remotePort:5555};
const safeHost=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
function python(){const p=vscode.workspace.getConfiguration('serialBridge').get('pythonPath','~/.local/share/serialbridge/venv/bin/python3');return p.startsWith('~/')?path.join(os.homedir(),p.slice(2)):p;}
function workspaceHost(){
 const workspace=vscode.workspace;
 const uri=workspace.workspaceFile?.scheme==='vscode-remote'?workspace.workspaceFile:workspace.workspaceFolders?.find(folder=>folder.uri.scheme==='vscode-remote')?.uri;
 if(!uri?.authority?.startsWith('ssh-remote+'))return '';
 let host;try{host=decodeURIComponent(uri.authority.slice('ssh-remote+'.length));}catch{return '';}
 return safeHost(host)?host:'';
}
function hosts(){
 let configured=[];
 try{configured=fs.readFileSync(path.join(os.homedir(),'.ssh/config'),'utf8').split(/\r?\n/).map(line=>line.replace(/#.*$/,'')).filter(line=>/^\s*Host\s/i.test(line)).flatMap(line=>line.trim().split(/\s+/).slice(1)).filter(safeHost);}catch{}
 return [...new Set([workspaceHost(),...configured].filter(Boolean))];
}
function newConfig(){return {...DEFAULT,host:hosts()[0]||'',remoteDirectory:validateRemoteDirectory(vscode.workspace.getConfiguration('serialBridge').get('remoteDirectory',DEFAULT_REMOTE_DIRECTORY))};}
function directoryOverride(){
 const setting=vscode.workspace.getConfiguration('serialBridge'),info=setting.inspect?.('remoteDirectory');
 if(info&&[info.globalValue,info.workspaceValue,info.workspaceFolderValue].some(value=>value!==undefined))return validateRemoteDirectory(setting.get('remoteDirectory',DEFAULT_REMOTE_DIRECTORY));
 return undefined;
}
let activeManager;
function activate(context){
 const output=vscode.window.createOutputChannel('串口映射');
 const saved=context.workspaceState.get('mappings');
 const legacy=context.workspaceState.get('config');
 const defaults=newConfig();
 const migrate=config=>({...defaults,...config,remoteDirectory:config?.remoteDirectory??LEGACY_REMOTE_DIRECTORY});
 const configs=Array.isArray(saved)&&saved.length?saved.map(item=>({...item,config:migrate(item.config)})):legacy&&typeof legacy==='object'?[{id:'legacy',config:migrate(legacy)}]:[{id:'default',config:defaults}];
 const manager=new MappingManager({configs,createBridge:config=>{
  const options={root:context.extensionPath,python:python()};
  return config.kind==='probe'?new ProbeBridge(options):new Bridge(options);
 }});activeManager=manager;
 let selectedId=context.workspaceState.get('selectedId')||configs[0].id;
 if(!configs.some(c=>c.id===selectedId))selectedId=configs[0].id;
 let devices=[],probes=[],panel,refreshing;
 const views=new Set(),instance=randomUUID();
 const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,40);
 status.command='serialBridge.open';status.text='$(plug) 串口映射';status.tooltip='打开本机 ↔ SSH 通道管理';status.show();
 const snapshot=()=>({type:'snapshot',mappings:manager.list().map(item=>({...item,session:token(instance,manager.get(item.id))})),selectedId,devices,probes,hosts:hosts()});
 const post=m=>{for(const webview of views)webview.postMessage(m);};
 function update(){
  const list=manager.list(),connected=list.filter(x=>x.phase==='connected').length,starting=list.some(x=>x.phase==='starting');
  status.text=connected?`$(plug) ${connected} 路已连接`:starting?'$(sync~spin) 通道连接中':'$(plug) 串口映射';
  status.tooltip=list.map(x=>`${x.config.kind==='probe'?'CMSIS-DAP':x.config.name}：${x.message}`).join('\n');post(snapshot());
 }
 function persist(){void context.workspaceState.update('mappings',manager.persisted()).then(undefined,e=>output.appendLine('保存参数失败：'+e.message));void context.workspaceState.update('selectedId',selectedId);}
 manager.on('snapshot',update);
 manager.on('data',m=>post(m));
 async function refresh(){
  if(refreshing)return refreshing;
  refreshing=(async()=>{
   const results=await Promise.allSettled([
    exec(python(),['-u',path.join(context.extensionPath,'helpers/local_serial.py'),'--list'],{timeout:7000,maxBuffer:256*1024}),
    exec(python(),['-u',path.join(context.extensionPath,'helpers/list_probes.py')],{timeout:7000,maxBuffer:256*1024})
   ]);
   if(results[0].status==='fulfilled'){
    devices=JSON.parse(results[0].value.stdout).map((d,i)=>({...d,label:/DAPLink/i.test(d.product||'')?'DAPLink 串口 · 日志/通信':d.label||d.name||d.product||`串口 ${i+1}`}));
   }else post({type:'notice',message:'无法刷新本机串口：'+results[0].reason.message});
   if(results[1].status==='fulfilled'){
    probes=JSON.parse(results[1].value.stdout);
   }else output.appendLine('探针枚举暂不可用：'+results[1].reason.message);
   for(const item of manager.list()){
    const entry=manager.get(item.id);
    if(entry.bridge.snapshot().phase!=='idle')continue;
    if(!entry.config.device){const used=manager.list().filter(x=>x.id!==entry.id).map(x=>x.config.device);const device=devices.find(d=>d.vid&&!used.includes(d.device));if(device)entry.config.device=device.device;}
    if(!entry.config.probeUID&&probes[0])entry.config.probeUID=probes[0].uid;
   }
   update();
  })();
  try{await refreshing;}catch(e){output.appendLine('刷新设备失败：'+e.message);post({type:'notice',message:e.message});}finally{refreshing=undefined;}
 }
 async function handle(m){
  try{
   if(!m||typeof m.command!=='string')return;
   if(m.command==='ready'){update();await refresh();return;}
   if(m.command==='refresh'){await refresh();return;}
   if(m.command==='add'){
    const all=manager.list();let number=1,name='ttyBoard';while(all.some(x=>x.config.name===name)){number++;name='ttyBoard'+number;}
    const used=all.map(x=>x.config.device),device=devices.find(d=>d.vid&&!used.includes(d.device));
    selectedId=manager.add({...newConfig(),name,device:device?.device||'',probeUID:probes[0]?.uid||''});persist();update();return;
   }
   if(m.command==='stopAll'){await manager.stopAll();update();return;}
   const entry=channelFor(m,manager,instance,m.command!=='select'),id=entry.id;
   if(m.command==='select'){selectedId=id;persist();update();return;}
   if(m.command==='remove'){await manager.remove(id);if(id===selectedId)selectedId=manager.list()[0]?.id;persist();update();return;}
   if(m.command==='start'){
    const config={...newConfig(),...entry.config,...m.config,remoteDirectory:directoryOverride()??entry.config.remoteDirectory??newConfig().remoteDirectory};
    if(config.kind==='probe'){
     if(!probes.some(p=>p.uid===config.probeUID))throw Error('探针已拔出，请刷新并重新选择');
    }else if(!devices.some(d=>d.device===config.device))throw Error('串口已拔出，请刷新并重新选择');
    try{await manager.start(id,config);}finally{persist();}
   }else if(m.command==='stop')await manager.stop(id);
   else if(m.command==='send')manager.send(id,m.text,m.hex,m.newline);
   else if(m.command==='copyPort'){
    const remote=entry.bridge.snapshot().remote;
    if(remote)await vscode.env.clipboard.writeText(remote.endpoint||remote.port);
   }else if(m.command==='openLog'){
    const remote=entry.bridge.snapshot().remote;
    if(!remote?.log)throw Error('当前通道没有串口日志');
    const config=entry.config;
    const authority=vscode.workspace.workspaceFile?.scheme==='vscode-remote'?vscode.workspace.workspaceFile.authority:vscode.workspace.workspaceFolders?.find(x=>x.uri.scheme==='vscode-remote')?.uri.authority;
    const expected='ssh-remote+'+config.host;
    const uri=vscode.Uri.from({scheme:'vscode-remote',authority:authority===expected?authority:expected,path:remote.log});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:true});
   }
  }catch(e){update();post({type:'notice',mappingId:m?.mappingId||selectedId,message:e.message});output.appendLine(e.stack||e.message);}
 }
 function attach(webview){webview.options={enableScripts:true,localResourceRoots:[context.extensionUri]};webview.html=html(webview,context.extensionUri);views.add(webview);const sub=webview.onDidReceiveMessage(handle);return {dispose(){views.delete(webview);sub.dispose();}};}
 context.subscriptions.push(output,status,vscode.window.registerWebviewViewProvider('serialBridge.mapping',{resolveWebviewView(view){const d=attach(view.webview);view.onDidDispose(()=>d.dispose());}},{webviewOptions:{retainContextWhenHidden:true}}));
 context.subscriptions.push(vscode.commands.registerCommand('serialBridge.open',()=>{if(panel){panel.reveal();return;}panel=vscode.window.createWebviewPanel('serialBridge.panel','串口映射 · 本机 ↔ SSH',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true});const d=attach(panel.webview);panel.onDidDispose(()=>{d.dispose();panel=undefined;});}));
 context.subscriptions.push(vscode.commands.registerCommand('serialBridge.stop',()=>manager.stopAll()));
 let monitoring=false;
 const presenceTimer=setInterval(async()=>{
  const active=captureProbes(manager);
  if(!active.length||monitoring)return;monitoring=true;
  try{const result=await exec(python(),['-u',path.join(context.extensionPath,'helpers/list_probes.py')],{timeout:7000,maxBuffer:256*1024});const present=new Set(JSON.parse(result.stdout).map(p=>p.uid));applyProbePresence(manager,active,present);}catch(e){output.appendLine('探针在位检查失败：'+e.message);}finally{monitoring=false;}
 },3000);presenceTimer.unref?.();
 context.subscriptions.push({dispose(){clearInterval(presenceTimer);void manager.stopAll();}});
 persist();update();return {snapshot:()=>snapshot(),stop:()=>manager.stopAll()};
}
async function deactivate(){await activeManager?.stopAll();}
module.exports={activate,deactivate};
