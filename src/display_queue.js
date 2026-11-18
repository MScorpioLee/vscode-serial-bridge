'use strict';
// This queue only feeds the log preview. UART forwarding and disk logs never use it.
const MAX_BYTES=256*1024,MAX_FRAMES=256,INTERVAL=75;
class DisplayQueue {
 constructor(publish){this.publish=publish;this.sessions=new Map();this.frames=[];this.bytes=0;this.dropped=new Map();this.timer=null;this.publishing=false;this.disposed=false;}
 current(frame){return this.sessions.get(frame.id)===frame.session;}
 setSessions(sessions){
  this.sessions=new Map(sessions);
  this.frames=this.frames.filter(frame=>this.current(frame));
  this.bytes=this.frames.reduce((n,frame)=>n+frame.data.length,0);
  for(const [id,session] of this.dropped)if(this.sessions.get(id)!==session)this.dropped.delete(id);
 }
 enqueue(frame){
  if(this.disposed||!this.current(frame))return;
  if(frame.data.length>MAX_BYTES){this.dropped.set(frame.id,frame.session);this.schedule();return;}
  this.frames.push(frame);this.bytes+=frame.data.length;
  while(this.frames.length>MAX_FRAMES||this.bytes>MAX_BYTES){
   const removed=this.frames.shift();this.bytes-=removed.data.length;this.dropped.set(removed.id,removed.session);
  }
  this.schedule();
 }
 schedule(){if(!this.disposed&&!this.timer&&!this.publishing&&(this.frames.length||this.dropped.size)){this.timer=setTimeout(()=>void this.flush(),INTERVAL);this.timer.unref?.();}}
 async flush(){
  clearTimeout(this.timer);this.timer=null;
  if(this.disposed||this.publishing||(!this.frames.length&&!this.dropped.size))return;
  const queued=this.frames;this.frames=[];this.bytes=0;
  const dropped=Array.from(this.dropped,([id,session])=>({id,session}));this.dropped.clear();
  const groups=[];
  for(const frame of queued){
   const last=groups[groups.length-1];
   if(last&&last.id===frame.id&&last.session===frame.session&&last.type===frame.type)last.chunks.push(Buffer.from(frame.data,'base64'));
   else groups.push({...frame,chunks:[Buffer.from(frame.data,'base64')]});
  }
  const frames=groups.map(({chunks,...frame})=>({...frame,data:Buffer.concat(chunks).toString('base64')}));
  this.publishing=true;
  try{await this.publish({type:'dataBatch',frames,dropped});}catch{/* A disposed webview must not stall other channels. */}
  finally{this.publishing=false;this.schedule();}
 }
 dispose(){this.disposed=true;clearTimeout(this.timer);this.timer=null;this.frames=[];this.bytes=0;this.dropped.clear();this.sessions.clear();}
}
module.exports={DisplayQueue};
