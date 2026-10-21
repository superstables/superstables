import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const real=fs.openSync;let once=true;
fs.openSync=function(path,...args){
 if(once&&process.env.AR_PAUSE_LOCK&&String(path).startsWith(process.env.AR_PAUSE_LOCK)&&String(path).endsWith('.tmp')){
  once=false;fs.writeFileSync(process.env.AR_PAUSE_SIGNAL,'ready');const until=Date.now()+120000;
  while(!fs.existsSync(process.env.AR_PAUSE_DONE)){if(Date.now()>until)throw Error('review hook timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
 }
 return real.call(this,path,...args);
};syncBuiltinESMExports();
