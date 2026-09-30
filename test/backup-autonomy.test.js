'use strict';
const assert = require('node:assert/strict');
const Backup = require('../frontend/app/backup.js');
const values = new Map();
global.localStorage = {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
global.FileReader = class { readAsText(file) { this.result=file; this.onload(); } };
const calls=[];
let result={ok:true};
global.AutonomyStore={importState:async p=>{calls.push(p);return result;}};
const bundle=key=>JSON.stringify({schema:Backup.SCHEMA,version:Backup.VERSION,store:{'starnet.save':'{}',[key]:JSON.stringify({initiative:'leash',reach:'sandbox',leashPerDay:6})}});
(async()=>{
  for(const key of ['starnet.autonomy.v1','skynet.autonomy.v1']){
    assert.equal((await Backup.importFile(bundle(key))).ok,true);
    assert.equal(calls.at(-1).initiative,'leash');
  }
  result={ok:false,error:'disk full'};
  const refused=await Backup.importFile(bundle('starnet.autonomy.v1'));
  assert.equal(refused.ok,false);assert.match(refused.error,/partly restored.*disk full/);
  const count=calls.length;
  assert.equal((await Backup.importFile(JSON.stringify({schema:Backup.SCHEMA,version:Backup.VERSION,store:{'starnet.save':'{}'}}))).ok,true);
  assert.equal(calls.length,count,'backup without autonomy must not reset it');
  console.log('backup-autonomy: PASS (current/legacy restore, refused write, absent posture)');
})().catch(e=>{console.error(e);process.exitCode=1;});
