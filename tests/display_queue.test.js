'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DisplayQueue}=require('../src/display_queue');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frame=(text,extra={})=>({id:'a',session:'a:1',type:'rx',data:Buffer.from(text).toString('base64'),...extra});
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(10);}assert.fail('display update did not arrive');}

test('a burst of tiny packets uses one display update while preserving direction and bytes',async()=>{
 const sent=[],q=new DisplayQueue(message=>sent.push(message));
 try{
  q.setSessions(new Map([['a','a:1']]));
  for(let i=0;i<100;i++)q.enqueue(frame('x'));
  q.enqueue(frame('command',{type:'tx'}));q.enqueue(frame('reply'));
  await until(()=>sent.length);
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].frames.map(f=>[f.type,Buffer.from(f.data,'base64').toString()]),[['rx','x'.repeat(100)],['tx','command'],['rx','reply']]);
  assert.deepEqual(sent[0].dropped,[]);
 }finally{q.dispose();}
});

test('a slow display cannot accumulate an unbounded preview or block a later update',async()=>{
 const sent=[];let release;
 const q=new DisplayQueue(message=>{sent.push(message);if(sent.length===1)return new Promise(resolve=>release=resolve);});
 try{
  q.setSessions(new Map([['a','a:1']]));q.enqueue(frame('first'));
  await until(()=>sent.length===1);
  for(let i=0;i<2000;i++)q.enqueue(frame('x'.repeat(1024)));
  await delay(100);assert.equal(sent.length,1);
  release();await until(()=>sent.length===2);
  assert.ok(sent[1].frames.reduce((n,f)=>n+f.data.length,0)<=350000,'preview payload must stay bounded during slow delivery');
  assert.deepEqual(sent[1].dropped,[{id:'a',session:'a:1'}]);
  q.enqueue(frame('still responsive'));await until(()=>sent.length===3);
  assert.equal(Buffer.from(sent[2].frames[0].data,'base64').toString(),'still responsive');
 }finally{release?.();q.dispose();}
});

test('stopping or rebinding a channel discards its queued old-session preview',async()=>{
 const sent=[],q=new DisplayQueue(message=>sent.push(message));
 try{
  q.setSessions(new Map([['a','a:1'],['b','b:1']]));
  q.enqueue(frame('old board'));q.enqueue(frame('other board',{id:'b',session:'b:1'}));
  q.setSessions(new Map([['a','a:2'],['b','b:1']]));
  q.enqueue(frame('late old board'));q.enqueue(frame('new board',{session:'a:2'}));
  await until(()=>sent.length);
  assert.deepEqual(sent[0].frames.map(f=>[f.id,f.session,Buffer.from(f.data,'base64').toString()]),[['b','b:1','other board'],['a','a:2','new board']]);
  q.enqueue(frame('stopped board',{session:'a:2'}));q.setSessions(new Map());
  await delay(100);assert.equal(sent.length,1);
 }finally{q.dispose();}
});
