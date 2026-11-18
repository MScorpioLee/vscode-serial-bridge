'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {html}=require('../src/panel');

// VS Code owns the outer webview; execute its actual inline script against DOM event boundaries.
function panel(){
 const source=html({},{}),nodes=new Map(),sent=[],paints=[];let receive;
 for(const match of source.matchAll(/\bid="([^"]+)"/g)){
  const handlers=new Map();
  nodes.set(match[1],{id:match[1],value:'',checked:false,disabled:false,hidden:false,scrollTop:0,scrollHeight:100,dataset:{},classList:{toggle(){}},appendChild(){},replaceChildren(){},reportValidity:()=>true,addEventListener:(name,handler)=>handlers.set(name,handler),fire:(name,event={})=>handlers.get(name)?.(event)});
 }
 let data='',paintCount=0;
 const textNode={get data(){return data;},set data(value){data=value;paintCount++;},get length(){return data.length;}};
 const document={getElementById:id=>nodes.get(id),createTextNode:()=>textNode,createElement:()=>({}),activeElement:null};
 vm.runInNewContext(source.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1],{
  document,window:{addEventListener:(name,handler)=>{if(name==='message')receive=handler;}},
  acquireVsCodeApi:()=>({getState:()=>({}),setState(){},postMessage:m=>sent.push(m)}),
  requestAnimationFrame:callback=>{paints.push(callback);return paints.length;},TextDecoder,Uint8Array,atob,
 });
 const snapshot=(session='current',phase='connected',extra={})=>receive({data:{type:'snapshot',selectedId:'a',devices:[{device:'/dev/mock'}],hosts:['host'],probes:[],mappings:[{id:'a',session,phase,config:{device:'/dev/mock',host:'host',name:'ttyMock',kind:'serial'},message:phase,...extra}]}});
 return {nodes,sent,snapshot,receive:message=>receive({data:message}),paint:()=>{while(paints.length)paints.shift()();},log:()=>data,paintCount:()=>paintCount};
}
test('high frequency preview paints once per animation frame and ignores an old binding',()=>{
 const p=panel();p.snapshot();const before=p.paintCount();
 for(let i=0;i<100;i++)p.receive({type:'dataBatch',frames:[{id:'a',session:'current',type:'rx',data:Buffer.from('log').toString('base64')}],dropped:[]});
 assert.equal(p.paintCount(),before,'incoming packets must not force synchronous layout');
 p.paint();assert.equal(p.paintCount(),before+1);assert.match(p.log(),/log/);
 p.snapshot('replacement');
 p.receive({type:'dataBatch',frames:[{id:'a',session:'current',type:'rx',data:Buffer.from('STALE-BOARD').toString('base64')}],dropped:[]});
 p.paint();assert.doesNotMatch(p.log(),/STALE-BOARD/);
});
test('clicking stop immediately blocks button and keyboard sends before the host replies',()=>{
 const p=panel();p.snapshot();p.nodes.get('sendText').value='command';
 p.nodes.get('sendText').fire('input');p.nodes.get('stop').fire('click');
 assert.equal(p.nodes.get('send').disabled,true);
 p.nodes.get('sendText').fire('keydown',{ctrlKey:true,key:'Enter',preventDefault(){}});
 assert.equal(p.sent.filter(m=>m.command==='stop').length,1);
 assert.equal(p.sent.filter(m=>m.command==='send').length,0);
});
test('failed cleanup lets the user retry stop while keeping the retained device configuration locked',()=>{
 const p=panel();p.snapshot('current','error',{cleanupPending:true});
 assert.equal(p.nodes.get('stop').disabled,false);
 assert.equal(p.nodes.get('start').disabled,true);
 assert.equal(p.nodes.get('configFields').disabled,true);
 p.nodes.get('stop').fire('click');
 assert.equal(p.sent.filter(m=>m.command==='stop').length,1);
 p.snapshot('finished','idle',{cleanupPending:false});
 assert.equal(p.nodes.get('configFields').disabled,false);
 assert.equal(p.nodes.get('start').disabled,false);
});
