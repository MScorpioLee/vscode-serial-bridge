'use strict';
function token(instance,entry){return `${instance}:${entry.id}:${entry.version}`;}
function channelFor(message,manager,instance,requireSession=true){
 if(typeof message?.mappingId!=='string'||!message.mappingId)throw Error('请选择明确的通道，旧面板请重新打开');
 const entry=manager.get(message.mappingId);
 if(requireSession&&message.session!==token(instance,entry))throw Error('通道连接已改变，请刷新面板后重试');
 return entry;
}
function captureProbes(manager){
 return manager.list().filter(item=>item.config.kind==='probe'&&item.phase==='connected').map(item=>{const entry=manager.get(item.id);return {id:item.id,version:entry.version,bridge:entry.bridge,uid:entry.config.probeUID};});
}
function applyProbePresence(manager,captured,present){
 for(const old of captured){
  let entry;try{entry=manager.get(old.id);}catch{continue;}
  if(entry.bridge!==old.bridge||entry.version!==old.version||entry.config.kind!=='probe'||entry.config.probeUID!==old.uid)continue;
  if(entry.bridge.snapshot().phase==='connected'&&!present.has(old.uid))entry.bridge.fail('探针已拔出，已关闭此通道');
 }
}
module.exports={token,channelFor,captureProbes,applyProbePresence};
