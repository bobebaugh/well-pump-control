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
 const nodes=new Map();const node=k=>{if(!nodes.has(k))nodes.set(k,{textContent:'',innerHTML:'',disabled:false,hidden:false,value:'',classList:{toggle(){}},addEventListener(){}});return nodes.get(k);};
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
test('actual editor publication flow reuses versions, retries delivery and recovers lost publication responses',async()=>{
 const h=await browserLogic();h.offline=true;
 await h.run('runBusy(publishPackage)');
 assert.equal((await h.store.listReleases()).length,1);assert.equal(h.writes,0);
 assert.match(h.node('#engine-status').textContent,/remains published/);
 h.offline=false;await h.run('runBusy(deliverPackage)');assert.equal(h.writes,1);
 await h.run('runBusy(publishPackage)');assert.equal((await h.store.listReleases()).length,1);
 h.loseResponse=true;
 await h.run("state.draft.events[0].displayName='Changed'; state.dirty.add('events'); runBusy(publishPackage)");
 assert.equal((await h.store.listReleases()).length,2);
 assert.match(h.node('#engine-status').textContent,/Publication confirmed/);
 await h.run('runBusy(deliverPackage)');assert.equal((await h.store.listReleases()).length,2);
 assert.equal(h.node('main').inert,false);
});
test('actual editor invalidates preview and reports unknown device status without fabricated identity',async()=>{
 const h=await browserLogic();await h.run('validatePackage()');
 assert.equal(h.run('state.runtimePackage !== null'),true);
 h.run('markDirty()');assert.equal(h.run('state.runtimePackage'),null);assert.equal(h.node('#engine-download').disabled,true);
 await h.run('refreshDeviceStatus()');assert.match(h.node('#device-package-state').textContent,/unknown/);
});
