import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {launchChrome,connectCDP,evalJS,collectDiagnostics,sleep} from '../scripts/lib/cdp.mjs';
import {materializeSeedWorkspace,waitDevReady} from '../scripts/lib/seed.mjs';
import {buildStates,closeOnly} from '../scripts/lib/states.mjs';
const require=createRequire(import.meta.url);
const {SidecarFixture,allocatePort}=require('../test/helpers/sidecar-fixture.js');
const out=path.resolve('.dogfood/system-polish');fs.mkdirSync(out,{recursive:true});
const fixture=SidecarFixture.create({timeoutMs:30000,env:{SKYNET_DEV:'1',SKYNET_CRON_ENABLED:'0',SKYNET_DEFAULT_MODEL:'test/model'}});
let browser,cdp;
const results=[];
async function navigate(method, params) {
  let timer;
  const loaded = new Promise((resolve,reject) => {
    timer=setTimeout(()=>reject(new Error('Page load timed out')),30000);
    cdp.on('Page.loadEventFired',()=>{clearTimeout(timer);resolve();});
  });
  try { await cdp.send(method,params);await loaded; }
  finally { clearTimeout(timer); }
  assert.equal(await waitDevReady(cdp,evalJS,{url:fixture.baseUrl}),true);
}
try{
  materializeSeedWorkspace(fixture.workspace,'test/model');await fixture.start();
  const port=await allocatePort();
  browser=launchChrome({cdpPort:port,profileDir:fs.mkdtempSync(path.join(os.tmpdir(),'starnet-polish-proof-'))});
  cdp=await connectCDP(port);await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  const diagnostics=collectDiagnostics(cdp);
  await navigate('Page.navigate',{url:fixture.baseUrl});
  const autonomy=await evalJS(cdp,`(async()=>{
    await AutonomyStore.init();StationUI.openTerm('settings','autonomy');
    while(AutonomyStore.status().pending)await new Promise(r=>setTimeout(r,25));
    const original=window.fetch;
    window.fetch=(url,opts)=>String(url)==='/api/autonomy/posture'&&opts?.method==='POST'?Promise.resolve(new Response(JSON.stringify({ok:false,error:'Audit save failure'}),{status:503})):original(url,opts);
    document.querySelector('[data-init="leash"]').click();
    const pending={disabled:document.querySelector('[data-init="leash"]').disabled,text:document.querySelector('#auto-desc').textContent};
    while(AutonomyStore.status().pending)await new Promise(r=>setTimeout(r,25));
    const failed={local:AutonomyStore.get(),backend:await(await original('/api/autonomy/posture')).json(),text:document.querySelector('#auto-desc').textContent,selected:document.querySelector('[data-init].sel')?.dataset.init};
    window.fetch=original;document.querySelector('[data-init="leash"]').click();
    while(AutonomyStore.status().pending)await new Promise(r=>setTimeout(r,25));
    document.querySelector('[data-pace="6"]').click();
    while(AutonomyStore.status().pending)await new Promise(r=>setTimeout(r,25));
    const saved={local:AutonomyStore.get(),text:document.querySelector('#auto-desc').textContent,backend:await(await original('/api/autonomy/posture')).json()};
    // A stale browser cache must never overwrite the durable server setting.
    localStorage.setItem('starnet.autonomy.v1',JSON.stringify({initiative:'free',reach:'reach',leashPerDay:12}));
    return {pending,failed,saved};
  })()`);
  assert.equal(autonomy.pending.disabled,true);assert.match(autonomy.pending.text,/Confirming/);
  assert.equal(autonomy.failed.selected,'wait');assert.equal(autonomy.failed.local.initiative,autonomy.failed.backend.summary.initiative);assert.match(autonomy.failed.text,/Audit save failure/);
  assert.equal(autonomy.saved.local.initiative,'leash');assert.equal(autonomy.saved.backend.summary.leashPerDay,6);
  results.push({autonomy});
  await navigate('Page.reload',{ignoreCache:true});
  const restored=await evalJS(cdp,'AutonomyStore.init().then(()=>AutonomyStore.get())');assert.equal(restored.initiative,'leash');assert.equal(restored.leashPerDay,6);assert.equal(restored.reach,'sandbox');results.push({reload:restored});
  await fixture.restart();
  await navigate('Page.navigate',{url:fixture.baseUrl});
  const restart=await evalJS(cdp,'AutonomyStore.init().then(()=>AutonomyStore.get())');assert.deepEqual(restart,restored);results.push({restart});
  const deliverables=await evalJS(cdp,`(async()=>{
    const original=window.fetch;let release;
    const held=new Promise(r=>release=r);
    window.fetch=(url,opts)=>String(url).startsWith('/audit-slow')?held:String(url).startsWith('/audit-fast')?Promise.resolve(new Response('Newest file')):String(url)==='/api/workshop/decide'?Promise.resolve(new Response('{}')):original(url,opts);
    const host=document.createElement('div');host.innerHTML='<div data-i="0"><a data-file="0">slow.md</a><a data-file="1">fast.md</a><div data-preview></div></div>';document.body.append(host);
    const rows=[{files:[{path:'slow.md',preview:'markdown',openUrl:'/audit-slow'},{path:'fast.md',preview:'markdown',openUrl:'/audit-fast'}]}],state={};
    const click=i=>({target:host.querySelectorAll('a')[i],preventDefault(){},stopPropagation(){}});
    const slow=Deliverables.handleOpenClick(click(0),rows,state,()=>{});await Deliverables.handleOpenClick(click(1),rows,state,()=>{});
    release(new Response('Older file'));await slow;
    const result={preview:host.innerText,missingAcknowledgement:await WorkshopStore.decide('agent','audit-missing-ack','keep')};
    host.remove();window.fetch=original;return result;
  })()`);
  assert.match(deliverables.preview,/Newest file/);assert.doesNotMatch(deliverables.preview,/Older file/);assert.equal(deliverables.missingAcknowledgement.ok,false);results.push({deliverables});
  for(const width of [1440,800]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    for(const state of buildStates()){
      const driven=await evalJS(cdp,state.drive);await sleep(state.wait||400);
      const row=await evalJS(cdp,`(()=>{const controls=[...document.querySelectorAll('button,input,select,textarea')].filter(e=>e.offsetParent!==null);return {native:controls.filter(e=>{const s=getComputedStyle(e);return ['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(s.backgroundColor)||s.borderColor==='rgb(118, 118, 118)';}).map(e=>e.id||e.className),overflow:document.documentElement.scrollWidth>innerWidth+1,controls:controls.length};})()`);
      results.push({width,state:state.name,driven,...row});
      assert.ok(!/NOTFOUND|ERROR|CLICK_ERR/.test(String(driven)),state.name);assert.deepEqual(row.native,[],state.name);assert.equal(row.overflow,false,state.name+' page overflow');
    }
    await evalJS(cdp,closeOnly);await evalJS(cdp,"StationUI.openTerm('settings')");
    const sections=await evalJS(cdp,"[...document.querySelectorAll('[id^=con-tab-settings-]')].map(e=>e.id)");
    for(const section of sections){
      await evalJS(cdp,`document.getElementById(${JSON.stringify(section)}).click()`);await sleep(150);
      const text=await evalJS(cdp,"document.querySelector('#terms').innerText");assert.ok(text.length>60,section);results.push({width,section,reached:true});
    }
  }
  assert.deepEqual(diagnostics.exceptions,[]);
  fs.writeFileSync(path.join(out,'live-proof.json'),JSON.stringify({results,diagnostics},null,2));
  console.log('PASS autonomy failure/pending/retry/reload/restart; '+results.filter(r=>r.state).length+' panel states; '+results.filter(r=>r.section).length+' settings tabs; zero uncaught exceptions');
}finally{
  fs.writeFileSync(path.join(out,'live-progress.json'),JSON.stringify(results,null,2));
  if(cdp)cdp.ws.close();
  if(browser&&browser.proc.exitCode===null){const done=new Promise(r=>browser.proc.once('exit',r));browser.proc.kill();await done;}
  await fixture.dispose();
}
