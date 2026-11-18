'use strict';
const {EventEmitter}=require('node:events');
const cp=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const MAX_LINE=256*1024, MAX_QUEUE=2*1024*1024;
const DEFAULT_REMOTE_DIRECTORY='~/.local/share/serialbridge';
// Pre-0.2.1 workspaces used this fixed directory; migration must preserve their logs.
const LEGACY_REMOTE_DIRECTORY='/workspace/.serial-logs';
function validateRemoteDirectory(value=DEFAULT_REMOTE_DIRECTORY){
 if(typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value)||!(value.startsWith('/')||value.startsWith('~/')))throw Error('远端运行目录应为绝对路径或 ~/ 下的目录');
 return value;
}
function validateConfig(c){
 if(!c||typeof c.device!=='string'||!c.device.startsWith('/dev/')||/[\r\n\0]/.test(c.device))throw Error('请选择本机串口');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(c.host||''))throw Error('SSH 主机名称无效');
 if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(c.name||''))throw Error('虚拟串口名称只能使用字母、数字、下划线');
 const v={...c,baud:Number(c.baud),dataBits:Number(c.dataBits),stopBits:Number(c.stopBits),remoteDirectory:validateRemoteDirectory(c.remoteDirectory)};
 if(!Number.isInteger(v.baud)||v.baud<50||v.baud>4000000)throw Error('波特率应为 50–4000000');
 if(![5,6,7,8].includes(v.dataBits)||![1,2].includes(v.stopBits)||!['none','even','odd'].includes(v.parity)||!['none','hardware','software'].includes(v.flowControl))throw Error('串口参数无效');
 return v;
}
function encodeSend(text,hex=false,newline='none'){
 if(typeof text!=='string')throw Error('请输入发送内容');
 let b;
 if(hex){const s=text.replace(/\s/g,'');if(!s||s.length%2||!/^[0-9a-f]+$/i.test(s))throw Error('HEX 应为成对十六进制字节，例如 01 FF 0A');b=Buffer.from(s,'hex');}
 else {const endings={none:'',lf:'\n',cr:'\r',crlf:'\r\n'};if(!(newline in endings))throw Error('换行设置无效');b=Buffer.from(text+endings[newline]);}
 if(!b.length||b.length>65536)throw Error('单次发送应为 1–65536 字节');return b;
}
function decodeData(data){if(typeof data!=='string'||data.length>90000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw Error('串口数据格式错误');return Buffer.from(data,'base64');}
class LineReader{
 constructor(onLine,max=MAX_LINE,parse=JSON.parse){this.buffer=Buffer.alloc(0);this.onLine=onLine;this.max=max;this.parse=parse;}
 push(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);let i;while((i=this.buffer.indexOf(10))!==-1){if(i>this.max)throw Error('映射消息过大');const line=this.buffer.subarray(0,i);this.buffer=this.buffer.subarray(i+1);if(line.length)this.onLine(this.parse(line.toString('utf8')));}if(this.buffer.length>this.max)throw Error('映射消息过大');}
}
// Account for all pending writes, including the stream's own queue.
class JsonWriter{
 constructor(stream,onError){this.stream=stream;this.onError=onError;this.pending=0;this.closed=false;stream.on('error',e=>{if(!this.closed)onError(e);});}
 send(obj){if(this.closed)throw Error('映射已关闭');const line=Buffer.from(JSON.stringify(obj)+'\n');if(this.pending+line.length>MAX_QUEUE)throw Error('映射接收方过慢，已停止以避免数据错乱');this.pending+=line.length;this.stream.write(line,e=>{this.pending-=line.length;if(e&&!this.closed)this.onError(e);});}
 end(){this.closed=true;this.stream.end();}
 abort(){this.closed=true;this.stream.destroy();}
}
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function remoteCommand(source,c){const code=`import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString('base64')}'),'serialbridge_remote.py','exec'))`;return ['python3','-u','-c',code,'--directory',validateRemoteDirectory(c.remoteDirectory),'--name',c.name,'--baud',String(c.baud),'--dev-alias'].map(quote).join(' ');}
class Bridge extends EventEmitter{
 constructor({root,python,spawn=cp.spawn,remoteSource}={}){super();this.root=root;this.python=python;this.spawn=spawn;this.remoteSource=remoteSource;this.phase='idle';this.message='尚未绑定';this.rxBytes=0;this.txBytes=0;this.children=[];this.generation=0;this.request=0;}
 snapshot(){return {phase:this.phase,message:this.message,rxBytes:this.rxBytes,txBytes:this.txBytes,remote:this.remote,config:this.config,cleanupPending:Boolean(this.children.length)};}
 update(){this.emit('snapshot',this.snapshot());}
 async start(input){
  if(this.phase==='connected'||this.phase==='starting')throw Error('映射已启动');
  const config=validateConfig(input);this.phase='starting';this.message='正在连接 SSH 并建立虚拟串口…';this.update();const request=++this.request;
  await this.closeChildren();if(request!==this.request)throw Error('映射已停止');
  this.config=config;this.rxBytes=0;this.txBytes=0;this.remote=undefined;
  const gen=++this.generation;
  return new Promise((resolve,reject)=>{
   this.resolveStart=resolve;this.rejectStart=reject;
   this.startTimer=setTimeout(()=>this.fail('连接超时，请检查 SSH 主机和串口占用',gen),20000);this.startTimer.unref?.();
   try{
    const source=this.remoteSource??fs.readFileSync(path.join(this.root,'helpers/remote_bridge.py'),'utf8');
    this.remoteChild=this.launch('/usr/bin/ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',this.config.host,remoteCommand(source,this.config)],'远端',msg=>this.onRemote(msg,gen),gen);
    this.remoteWriter=this.remoteChild.writer;
   }catch(e){this.fail(e.message,gen);}
  });
 }
 launch(exe,args,label,onLine,gen,{text=false}={}){
  const child=this.spawn(exe,args,{stdio:['pipe','pipe','pipe'],shell:false});
  // A descendant can keep stdout/stderr open after this process has exited.
  // Process exit is the ownership boundary; stdio 'close' is not.
  child.bridgeExited=false;
  child.bridgeExit=new Promise(resolve=>{
   const exited=()=>{child.bridgeExited=true;resolve();};
   child.once('exit',exited);child.once('close',exited);
   child.on('error',()=>{if(child.pid===undefined)exited();});
  });
  child.bridgeClosed=false;child.bridgeClose=new Promise(resolve=>child.once('close',()=>{child.bridgeClosed=true;resolve();}));
  this.children.push(child);let stderr='';
  child.writer=new JsonWriter(child.stdin,e=>this.fail(`${label}：${e.message}`,gen));
  const dispatch=msg=>{if(gen===this.generation)onLine(msg);};
  const reader=new LineReader(dispatch,MAX_LINE,text?(s=>s):JSON.parse);
  const errorReader=text?new LineReader(dispatch,MAX_LINE,s=>s):undefined;
  child.stdout.on('data',x=>{if(gen!==this.generation)return;try{reader.push(x);}catch(e){this.fail(`${label}：${e.message}`,gen);}});
  child.stderr.on('data',x=>{if(gen!==this.generation)return;stderr=(stderr+x.toString()).slice(-2000);if(errorReader){try{errorReader.push(x);}catch(e){this.fail(`${label}：${e.message}`,gen);}}});
  child.on('error',e=>this.fail(`${label}：${e.message}`,gen));
  const ended=(code,signal)=>{if(gen===this.generation&&['connected','starting'].includes(this.phase))this.fail(`${label}连接已结束${stderr.trim()?'：'+stderr.trim():` (${signal||code})`}`,gen);};
  child.on('exit',ended);child.on('close',ended);return child;
 }
 onRemote(msg,gen){
  if(msg.type==='error'){this.fail(msg.message||'远端映射失败',gen);return;}
  if(msg.type==='ready'){
   if(this.localChild)return;
   if(![msg.port,msg.log,msg.status].every(x=>typeof x==='string'&&x.startsWith('/')))throw Error('远端路径无效');
   this.remote={port:msg.port,log:msg.log,status:msg.status};const c=this.config;
   this.message='正在打开本机串口…';this.update();
   this.localChild=this.launch(this.python,['-u',path.join(this.root,'helpers/local_serial.py'),'--port',c.device,'--baud',String(c.baud),'--data-bits',String(c.dataBits),'--stop-bits',String(c.stopBits),'--parity',c.parity,'--flow-control',c.flowControl],'本机串口',m=>this.onLocal(m,gen),gen);
   this.localWriter=this.localChild.writer;
  }else if(msg.type==='write'&&this.phase==='connected'){
   const heartbeat=this.heartbeats?.get(msg.last_heartbeat_id);
   if(heartbeat===undefined||Date.now()-heartbeat>5000){this.fail('远端指令已过期，已停止映射；请重新绑定后再发送',gen);return;}
   decodeData(msg.data);this.localWriter.send({type:'write',data:msg.data,id:String(msg.id||'remote').slice(0,100)});
  }
 }
 onLocal(msg,gen){
  if(msg.type==='error'){this.fail(msg.message||'本机串口连接失败',gen);return;}
  if(msg.type==='ready'){
   this.phase='connected';this.message=`已双向绑定 · ${this.config.baud} 波特率`;clearTimeout(this.startTimer);
   this.heartbeats=new Map();this.heartbeatSeq=0;this.sendHeartbeat();this.heartbeatTimer=setInterval(()=>{try{this.sendHeartbeat();}catch(e){this.fail(e.message,gen);}},1000);this.heartbeatTimer.unref?.();
   this.remoteWriter.send({type:'state',connected:true,baud:this.config.baud});this.update();const done=this.resolveStart;this.resolveStart=undefined;this.rejectStart=undefined;done?.();
  }else if((msg.type==='rx'||msg.type==='tx')&&this.phase==='connected'){
   const data=decodeData(msg.data);this[msg.type==='rx'?'rxBytes':'txBytes']+=data.length;
   this.remoteWriter.send({type:msg.type,data:msg.data,id:msg.id});this.emit('data',{type:msg.type,data:msg.data});
   if(!this.updateTimer)this.updateTimer=setTimeout(()=>{this.updateTimer=undefined;this.update();},200);
  }
 }
 sendHeartbeat(){if(this.phase!=='connected')return;const now=Date.now(),id=`${this.generation}-${++this.heartbeatSeq}`;this.heartbeats.set(id,now);for(const [key,time] of this.heartbeats)if(now-time>5000)this.heartbeats.delete(key);this.remoteWriter.send({type:'heartbeat',id});}
 send(text,hex,newline){if(this.phase!=='connected')throw Error('请先启动映射');const data=encodeSend(text,hex,newline);this.localWriter.send({type:'write',data:data.toString('base64'),id:'ui-'+Date.now()});}
 fail(message,gen=this.generation){if(gen!==this.generation)return;const reject=this.rejectStart;this.rejectStart=undefined;this.resolveStart=undefined;this.phase='error';this.message=String(message).slice(0,3000);clearTimeout(this.startTimer);this.update();reject?.(Error(this.message));void this.closeChildren().catch(()=>{});}
 async closeChild(child){
  const exited=()=>child.bridgeExited||(child.exitCode!==null&&child.exitCode!==undefined)||(child.signalCode!==null&&child.signalCode!==undefined);
  if(!exited()){
   try{
    // Stopping must discard queued writes, not deliver a backlog before 'stop'.
    if(child.writer.pending)child.writer.abort();
    else {child.writer.send({type:'state',connected:false,baud:this.config?.baud});child.writer.send({type:'stop'});child.writer.end();}
   }catch{child.writer.abort();}
   let term,force,deadline;
   try{
    await Promise.race([child.bridgeExit,new Promise((_,reject)=>{
     const kill=signal=>{try{child.kill(signal);}catch{}};
     term=setTimeout(()=>kill('SIGTERM'),800);
     force=setTimeout(()=>kill('SIGKILL'),2800);
     deadline=setTimeout(()=>reject(Error('无法确认映射进程已退出，设备仍保留占用；请重试停止')),4000);
    })]);
   }finally{clearTimeout(term);clearTimeout(force);clearTimeout(deadline);}
  }
  // Once exit is confirmed, destroy our pipe ends rather than waiting for a
  // descendant to close inherited descriptors. This also drops remaining I/O.
  child.writer.abort();child.stdout.destroy();child.stderr.destroy();
 }
 async closeChildren(){
  ++this.generation;clearInterval(this.heartbeatTimer);this.heartbeatTimer=undefined;clearTimeout(this.startTimer);clearTimeout(this.updateTimer);this.updateTimer=undefined;
  if(this.closing)return this.closing;
  const children=[...this.children];this.localChild=undefined;this.remoteChild=undefined;this.localWriter=undefined;this.remoteWriter=undefined;
  // Install the shared task before stream callbacks can re-enter cleanup.
  const closing=Promise.resolve().then(async()=>{
   const results=await Promise.allSettled(children.map(child=>this.closeChild(child)));
   for(let i=0;i<children.length;i++)if(results[i].status==='fulfilled')this.children=this.children.filter(child=>child!==children[i]);
   const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }).catch(error=>{
   this.phase='error';this.message=error.message;this.update();throw error;
  }).finally(()=>{if(this.closing===closing)this.closing=undefined;});
  this.closing=closing;return closing;
 }
 async stop(notify=true){const request=++this.request;const reject=this.rejectStart;this.rejectStart=undefined;this.resolveStart=undefined;this.phase='stopping';this.message='正在停止映射…';if(notify)this.update();reject?.(Error('映射已停止'));await this.closeChildren();if(request===this.request){this.phase='idle';this.message='映射已停止';if(notify)this.update();}}
}
module.exports={Bridge,LineReader,JsonWriter,validateConfig,encodeSend,remoteCommand,decodeData,validateRemoteDirectory,DEFAULT_REMOTE_DIRECTORY,LEGACY_REMOTE_DIRECTORY};
