'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {fakeFirestore}=require('./fixtures/memory-firestore');
const {createRulesEngineV3Store}=require('../cloud/netlify/lib/rules-engine-v3-store');
const {defaults}=require('../cloud/netlify/lib/rules-engine-v3-defaults');
const {makeBackup,readBackup}=require('../cloud/netlify/lib/rules-engine-v3-backup');
const {_createHandler}=require('../cloud/netlify/functions/rules-engine');
function harness() {
 const memory=fakeFirestore();
 const store=createRulesEngineV3Store({firebase:{getPilotFirestore:()=>({db:memory.db})}});
 let pointerWrites=0, failDelivery=false;
 const handler=_createHandler({env:{PILOT_INGEST_TOKEN:'fixture'},createV3Store:()=>store,createV3Delivery:()=>({publishPointer:async()=>{if(failDelivery) throw Error('test offline');pointerWrites++;}}),readDeviceStatus:async()=>null,now:()=>new Date('2026-09-11T12:00:00Z')});
 const call=async(action,data={},method='POST',query={version:'3'})=>{const r=await handler({httpMethod:method,headers:{'x-pilot-key':'fixture'},queryStringParameters:query,body:JSON.stringify({action,...data})});return {...JSON.parse(r.body),code:r.statusCode};};
 return {memory,store,call,get writes(){return pointerWrites},set offline(v){failDelivery=v}};
}
test('empty store -> full backup import -> validated immutable release -> delivery retry',async()=>{
 const h=harness(), original=defaults(), backup=makeBackup(original);
 let loaded=await h.call(null,{},'GET');
 assert.equal(h.memory.values.size,0,'GET does not seed');
 assert.deepEqual(loaded.draft.revisions,{devices:0,calculatedFields:0,systemFields:0,events:0});
 const preview=await h.call('previewImport',{backup});assert.equal(preview.code,200);assert.equal(h.memory.values.size,0);
 const imported=await h.call('import',{backup,baseRevisions:preview.baseRevisions});assert.equal(imported.code,200);assert.equal(h.writes,0);
 assert.deepEqual(readBackup(makeBackup(imported.draft)).draft,original);
 assert.equal((await h.call('validate')).status,'valid');
 const published=await h.call('publish',{basePackageVersion:0,baseRevisions:imported.draft.revisions});assert.equal(published.code,201);
 h.offline=true;assert.notEqual((await h.call('deliver',{releaseId:published.current.releaseId})).code,200);
 h.offline=false;assert.equal((await h.call('deliver',{releaseId:published.current.releaseId})).code,200);
 assert.equal((await h.store.listReleases()).length,1);assert.equal(h.writes,1);
 const release=await h.store.getRelease(published.current.releaseId);assert.deepEqual(release.authoringPackage,original);
});
test('malformed and stale imports leave every draft section and publication unchanged',async()=>{
 const h=harness(), backup=makeBackup(defaults());
 const preview=await h.call('previewImport',{backup});await h.call('import',{backup,baseRevisions:preview.baseRevisions});
 const before=JSON.stringify([...h.memory.values]);
 assert.equal((await h.call('import',{backup,baseRevisions:preview.baseRevisions})).code,409);
 for(const broken of [JSON.parse('{}'),{...backup,backupVersion:2},{...backup,authoringPackage:{...backup.authoringPackage,events:[null]}}]) assert.equal((await h.call('import',{backup:broken,baseRevisions:{devices:1,calculatedFields:1,systemFields:1,events:1}})).code,400);
 assert.equal(JSON.stringify([...h.memory.values]),before);assert.equal(h.writes,0);
});
test('unfinished and unsupported authoring can be restored but not published',async()=>{
 const h=harness(), d=defaults();d.calculatedFields[1].expression='unfinished +';
 const backup=makeBackup(d), preview=await h.call('previewImport',{backup});
 assert.equal(preview.code,200);assert.equal(preview.valid,false);
 assert.equal((await h.call('import',{backup,baseRevisions:preview.baseRevisions})).code,200);
 assert.equal((await h.call('publish',{basePackageVersion:0})).code,400);assert.equal(h.writes,0);assert.equal((await h.store.listReleases()).length,0);
 assert.deepEqual(makeBackup((await h.store.readDraft()).draft),backup);
});
test('compiled runtime JSON is not accepted as an authoring backup',()=>{
 assert.ok(readBackup({schemaVersion:3,kind:'well-pump-event-runtime-v3',devices:[]}).errors.length);
});
