// Local browser acceptance: every request is intercepted; no live services.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const {fakeFirestore}=require('./fixtures/memory-firestore');
const {createRulesEngineV3Store}=require('../cloud/netlify/lib/rules-engine-v3-store');
const {_createHandler}=require('../cloud/netlify/functions/rules-engine');
const {defaults}=require('../cloud/netlify/lib/rules-engine-v3-defaults');
const {makeBackup}=require('../cloud/netlify/lib/rules-engine-v3-backup');
(async()=>{
 const memory=fakeFirestore(),store=createRulesEngineV3Store({firebase:{getPilotFirestore:()=>({db:memory.db})}});
 let failDelivery=false, failPublishResponse=false, writes=0;
 const handler=_createHandler({env:{PILOT_INGEST_TOKEN:'fixture'},createV3Store:()=>store,createV3Delivery:()=>({publishPointer:async()=>{if(failDelivery) throw Error('fixture offline');writes++;}}),readDeviceStatus:async()=>null});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message)); page.on('dialog',d=>d.accept());
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/.netlify/functions/rules-engine') {
   const response=await handler({httpMethod:request.method(),headers:request.headers(),queryStringParameters:Object.fromEntries(url.searchParams),body:request.postData()||''});
   if(failPublishResponse && request.postData()?.includes('"action":"publish"')) {failPublishResponse=false;await route.abort();return;}
   await route.fulfill({status:response.statusCode,headers:response.headers,body:response.body});
  } else {
   const file=path.join(root,'web',url.pathname==='/'?'rules-engine.html':url.pathname);
   if(!fs.existsSync(file)) {await route.fulfill({status:404,body:''});return;}
   await route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
  }
 });
 await page.goto('http://editor.test/');
 await page.evaluate(()=>sessionStorage.setItem('pilotMonitorKey','fixture'));
 await page.click('#engine-load');await page.waitForFunction(()=>state.draft!==null && !state.busy);
 assert.equal(memory.values.size,0);
 const original=defaults(),backup=makeBackup(original);
 await page.setInputFiles('#backup-file',{name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.waitForFunction(()=>state.importCandidate!==null && !state.busy);
 assert.equal(memory.values.size,0);
 await page.click('#apply-import');await page.waitForFunction(()=>state.importCandidate===null && !state.busy);
 assert.deepEqual(makeBackup((await store.readDraft()).draft),backup);
 const downloaded=page.waitForEvent('download');await page.click('#engine-backup');const download=await downloaded;
 const stream=await download.createReadStream();let text='';for await(const chunk of stream) text+=chunk;
 assert.deepEqual(JSON.parse(text),backup,'backup preserves complete imported model');
 await page.click('[data-section="events"]');
 await page.fill('#event-system-name','Bad Name');await page.click('#engine-validate');await page.waitForFunction(()=>!state.busy);
 await page.click('[data-finding-path="events[0].systemName"]');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'event-system-name');
 await page.fill('#event-system-name',original.events[0].systemName);
 failDelivery=true;await page.click('#engine-publish');await page.waitForFunction(()=>!state.busy);
 assert.equal((await store.listReleases()).length,1);assert.equal(writes,0);
 assert.match(await page.textContent('#engine-status'),/remains published/);
 failDelivery=false;await page.click('#engine-deliver');await page.waitForFunction(()=>!state.busy);
 assert.equal(writes,1);assert.equal((await store.listReleases()).length,1);
 assert.match(await page.textContent('#engine-status'),/Awaiting Tab5 staging confirmation/);
 await page.click('#engine-publish');await page.waitForFunction(()=>!state.busy);
 assert.equal((await store.listReleases()).length,1,'unchanged publish reuses version');
 await page.fill('#event-display-name','Revised title');failPublishResponse=true;
 await page.click('#engine-publish');await page.waitForFunction(()=>!state.busy);
 assert.equal((await store.listReleases()).length,2);assert.match(await page.textContent('#engine-status'),/Publication confirmed/);
 await page.click('#engine-deliver');await page.waitForFunction(()=>!state.busy);
 assert.equal((await store.listReleases()).length,2);
 await page.click('[data-section="devices"]');
 await page.click('#engine-list [data-select="1"]');
 await page.screenshot({path:'/tmp/rules-editor-review.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Browser acceptance passed: empty store, backup round trip, actionable validation, failed delivery/retry, unchanged publication, interrupted publication recovery.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
