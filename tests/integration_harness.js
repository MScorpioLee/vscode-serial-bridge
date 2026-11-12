// Test-only actual Python helpers with the remote process on a temporary local directory.
const path=require('node:path'),cp=require('node:child_process');
const {Bridge}=require('../src/bridge');
const root=path.resolve(__dirname,'..');
const b=new Bridge({root,python:process.env.BRIDGE_PYTHON,spawn:(exe,args,options)=>exe==='/usr/bin/ssh'&&process.env.BRIDGE_REAL_SSH?cp.spawn(exe,args,options):exe==='/usr/bin/ssh'?cp.spawn(process.env.BRIDGE_PYTHON,['-u',path.join(root,'helpers/remote_bridge.py'),'--directory',process.env.BRIDGE_RUNTIME,'--name','ttyTest','--baud','115200'],options):cp.spawn(exe,args,options)});
const out=o=>process.stdout.write(JSON.stringify(o)+'\n');
b.on('snapshot',out);b.on('data',out);
b.start({device:process.env.BRIDGE_PORT,host:process.env.BRIDGE_HOST||'ssh-target',name:'ttyTest',remoteDirectory:process.env.BRIDGE_RUNTIME,baud:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none'}).catch(e=>out({error:e.message}));
process.stdin.on('data',()=>b.stop().then(()=>process.exit(0)));
