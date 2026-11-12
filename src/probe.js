'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {Bridge,validateRemoteDirectory}=require('./bridge');
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
function validateProbe(c){
 if(!c||c.kind!=='probe'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(c.probeUID||''))throw Error('探针标识无效');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(c.host||''))throw Error('SSH 主机名称无效');
 const remotePort=Number(c.remotePort??5555);if(!Number.isInteger(remotePort)||remotePort<1024||remotePort>65535)throw Error('探针远端端口应为 1024–65535');
 return {...c,remotePort,remoteDirectory:validateRemoteDirectory(c.remoteDirectory)};
}
function allocatePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});}
function command(source,c){const code=`import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString('base64')}'),'probe_remote.py','exec'))`;return ['python3','-u','-c',code,'--directory',validateRemoteDirectory(c.remoteDirectory),'--port',String(c.remotePort),'--uid',c.probeUID].map(quote).join(' ');}
class ProbeBridge extends Bridge{
 constructor({portAllocator=allocatePort,probeRemoteSource,...options}={}){super(options);this.portAllocator=portAllocator;this.probeRemoteSource=probeRemoteSource??options.remoteSource;}
 async start(input){
  if(['connected','starting'].includes(this.phase))throw Error('探针通道已启动');
  const config=validateProbe(input),request=++this.request;this.phase='starting';this.message='正在建立探针通道…';this.update();
  await this.closeChildren();if(request!==this.request)throw Error('映射已停止');
  let localPort;try{localPort=await this.portAllocator();}catch(e){if(request===this.request){this.phase='error';this.message=e.message;this.update();}throw e;}
  if(request!==this.request)throw Error('映射已停止');
  if(!Number.isInteger(localPort)||localPort<1024||localPort>65535){this.phase='error';this.message='本机探针端口无效';this.update();throw Error(this.message);}
  this.config=config;this.localPort=localPort;this.remote=undefined;this.rxBytes=0;this.txBytes=0;const gen=++this.generation;
  return new Promise((resolve,reject)=>{
   this.resolveStart=resolve;this.rejectStart=reject;
   this.startTimer=setTimeout(()=>this.fail('探针通道连接超时，请检查 SSH 与探针占用',gen),20000);this.startTimer.unref?.();
   try{this.localChild=this.launch(this.python,['-u','-m','pyocd','server','--uid',`cmsisdap:${config.probeUID}`,'--port',String(localPort),'--color','never','-O','no_config=true','-O','serve_local_only=true'],'本机探针服务',line=>this.onProbeLine(line,gen),gen,{text:true});}
   catch(e){this.fail(e.message,gen);}
  });
 }
 onProbeLine(line,gen){
  const ready=/Serving debug probe .* \(([^()]*)\) on port (\d+)\s*(?:\[[^\]\r\n]*\])?\s*$/.exec(line);if(!ready)return;
  if(ready[1]!==this.config.probeUID||Number(ready[2])!==this.localPort){this.fail('探针身份或本机端口与所选配置不符',gen);return;}
  if(this.remoteChild)return;
  const source=this.probeRemoteSource??fs.readFileSync(path.join(this.root,'helpers/probe_remote.py'),'utf8');
  this.message='正在核对 远端探针通道身份…';this.update();
  this.remoteChild=this.launch('/usr/bin/ssh',['-T','-S','none','-o','ControlMaster=no','-o','ControlPersist=no','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ExitOnForwardFailure=yes','-R',`127.0.0.1:${this.config.remotePort}:127.0.0.1:${this.localPort}`,this.config.host,command(source,this.config)],'远端探针通道',msg=>this.onProbeRemote(msg,gen),gen);
  this.remoteWriter=this.remoteChild.writer;
 }
 onProbeRemote(msg,gen){
  if(msg.type==='error'){this.fail(msg.message||'远端探针通道核对失败',gen);return;}
  if(msg.type!=='ready'||this.phase!=='starting')return;
  const port=`127.0.0.1:${this.config.remotePort}`;
  if(msg.port!==port||msg.endpoint!==`remote:${port}`||typeof msg.status!=='string'||!msg.status.startsWith('/')||/[\r\n\0]/.test(msg.status))throw Error('远端探针通道返回的地址无效');
  this.remote={port:msg.port,endpoint:msg.endpoint,status:msg.status};this.phase='connected';this.message='探针通道已打通，尚未连接芯片';clearTimeout(this.startTimer);
  this.heartbeats=new Map();this.heartbeatSeq=0;this.sendHeartbeat();this.heartbeatTimer=setInterval(()=>{try{this.sendHeartbeat();}catch(e){this.fail(e.message,gen);}},1000);this.heartbeatTimer.unref?.();
  const done=this.resolveStart;this.resolveStart=undefined;this.rejectStart=undefined;this.update();done?.();
 }
 send(){throw Error('探针通道不支持串口发送；尚未连接芯片');}
}
module.exports={ProbeBridge};
