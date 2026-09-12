'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {defaults}=require('../cloud/netlify/lib/rules-engine-v3-defaults');
const {_createHandler}=require('../cloud/netlify/functions/rules-engine');
const {createRulesEngineV3Store}=require('../cloud/netlify/lib/rules-engine-v3-store');
const {fakeFirestore}=require('./fixtures/memory-firestore');
async function browserLogic() {
 const memory=fakeFirestore(),store=createRulesEngineV3Store({firebase:{getPilotFirestore:()=>({db:memory.db})}});
 await store.loadOrSeed(defaults(),1);
 let deliveryFailure=false,publishResponseLost=false,deliveryWrites=0;
 const handler=_createHandler({env:{PILOT_INGEST_TOKEN:'fixture'},createV3Store:()=>store,createV3Delivery:()=>({publishPointer:async()=>{if(deliveryFailure) throw Error('offline');deliveryWrites++;}}),readDeviceStatus:async()=>null});
 const nodes=new Map();const node=k=>{if(!nodes.has(k))nodes.set(k,{textContent:'',innerHTML:'',disabled:false,hidden:false,value:'',open:false,showModal(){this.open=true},close(){this.open=false},classList:{toggle(){}},addEventListener(){}});return nodes.get(k);};
 const sandbox={console,URL,Blob,Date,document:{querySelector:node,querySelectorAll:()=>[]},window:{confirm:()=>true,addEventListener(){}},sessionStorage:{getItem:()=> 'fixture',setItem(){},removeItem(){}},fetch:async(url,options)=>{
   const parsed=new URL(url,'http://fixture');const r=await handler({httpMethod:options.method,headers:options.headers,body:options.body,queryStringParameters:Object.fromEntries(parsed.searchParams)});
   if(publishResponseLost && JSON.parse(options.body||'{}').action==='publish') {publishResponseLost=false;throw Error('response interrupted');}
   return {ok:r.statusCode<400,status:r.statusCode,json:async()=>JSON.parse(r.body)};
 }};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require.resolve('../web/rules-engine.js'),'utf8'),sandbox);
 const run=code=>vm.runInContext(code,sandbox);
 await run('loadDraft()');
 return {run,store,node,set offline(v){deliveryFailure=v},set loseResponse(v){publishResponseLost=v},get writes(){return deliveryWrites}};
}
test('actual editor publication flow creates deliberate versions, retries delivery and recovers lost publication responses',async()=>{
 const h=await browserLogic();h.offline=true;
 await h.run('runBusy(publishPackage)');
 assert.equal((await h.store.listReleases()).length,1);assert.equal(h.writes,0);
 assert.match(h.node('#engine-status').textContent,/remains published/);
 h.offline=false;await h.run('runBusy(deliverPackage)');assert.equal(h.writes,1);
 await h.run('runBusy(publishPackage)');assert.equal((await h.store.listReleases()).length,2);
 h.loseResponse=true;
 await h.run("state.draft.events[0].displayName='Changed'; state.dirty.add('events'); runBusy(publishPackage)");
 assert.equal((await h.store.listReleases()).length,3);
 assert.match(h.node('#engine-status').textContent,/Publication confirmed/);
 await h.run('runBusy(deliverPackage)');assert.equal((await h.store.listReleases()).length,3);
 assert.equal(h.node('main').inert,false);
});
test('actual editor invalidates preview and reports unknown device status without fabricated identity',async()=>{
 const h=await browserLogic();await h.run('validatePackage()');
 assert.equal(h.run('state.runtimePackage !== null'),true);
 h.run('markDirty()');assert.equal(h.run('state.runtimePackage'),null);assert.equal(h.node('#engine-download').disabled,true);
 await h.run('refreshDeviceStatus()');assert.match(h.node('#device-package-state').textContent,/unknown/);
});

test('all Load sources and Validate preserve saved rules until an explicit atomic save',async()=>{
 const h=await browserLogic();
 const saved=await h.store.readDraft();
 // Represent the owner reproduction: saved 266, backed-up 265.
 const voltage=e=>e.opening.trigger.condition.clauses.find(c=>c.field==='SupplyVoltage');
 const draft=structuredClone(saved.draft); voltage(draft.events.find(e=>e.id==='E007')).value=266;
 await h.store.replaceDraft(draft,saved.draft.revisions,2); await h.run('loadDraft()');
 const before=await h.store.readDraft();
 const backup={kind:'well-pump-rules-authoring-backup',backupVersion:1,authoringPackage:JSON.parse(h.run('JSON.stringify(authoringDraft())'))};
 voltage(backup.authoringPackage.events.find(e=>e.id==='E007')).value=265;
 const text=JSON.stringify(backup);
 await h.run(`loadWorking('backup',{name:'owner-backup.json',size:${text.length},text:async()=>${JSON.stringify(text)}})`);
 assert.equal(h.run("state.draft.events.find(e=>e.id==='E007').opening.trigger.condition.clauses[0].value"),265);
 await h.run('validatePackage()');assert.deepEqual(await h.store.readDraft(),before);
 await h.run('loadDraft()');assert.equal(h.run("state.draft.events.find(e=>e.id==='E007').opening.trigger.condition.clauses[0].value"),266);
 await h.run("loadWorking('seed')");assert.deepEqual(await h.store.readDraft(),before);
 await h.run('saveAll()');assert.notDeepEqual((await h.store.readDraft()).draft,before.draft);
 await h.run('publishPackage()'); const published=(await h.store.listReleases())[0];
 h.node('#release-select').value=published.releaseId;
 const beforeHistory=await h.store.readDraft();await h.run("loadWorking('published')");assert.deepEqual(await h.store.readDraft(),beforeHistory);
 await h.run('openLoad()');assert.equal(h.node('#load-dialog').open,true);
});
test('malformed load and concurrent save preserve editor and stored configuration',async()=>{
 const h=await browserLogic(),before=await h.store.readDraft();
 await assert.rejects(h.run("loadWorking('backup',{name:'bad.json',size:2,text:async()=>'{}'})"));
 assert.deepEqual(await h.store.readDraft(),before);
 await h.run("loadWorking('seed')");
 await h.store.saveSection('events',before.draft.revisions.events,before.draft.events,2);
 const concurrent=await h.store.readDraft();
 await assert.rejects(h.run('saveAll()'));
 assert.deepEqual(await h.store.readDraft(),concurrent);
 assert.equal(h.run('state.dirty.size'),4);
});
