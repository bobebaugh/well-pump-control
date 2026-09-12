'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {readDeviceStatus}=require('../cloud/netlify/lib/rules-engine-v3-device-status');
const {_createHandler}=require('../cloud/netlify/functions/rules-engine');
const reference={releaseId:'20260912001035-event-v3-v15',packageVersion:15,runtimeSchemaVersion:3,contentHash:'a'.repeat(64)};
const report={schemaVersion:2,kind:'rules-v3-runtime-state',siteId:'well-main',deviceId:'tab5-well-main',sessionId:'fixture',reportedAtMs:1,executionEnabled:true,executionState:'running',running:reference,staged:reference,desired:reference};
test('device report distinguishes absent, invalid, timeout and valid reports',async()=>{
 assert.equal(await readDeviceStatus({read:async()=>null}),null);
 await assert.rejects(readDeviceStatus({read:async()=>({schemaVersion:1})}),{code:'tab5_status_invalid'});
 await assert.rejects(readDeviceStatus({read:()=>new Promise(()=>{}),timeoutMs:5}),{code:'tab5_status_timeout'});
 const actual=await readDeviceStatus({read:async()=>report});assert.deepEqual(actual.running,reference);
});
test('status endpoint exposes useful categories without leaking transport details',async()=>{
 const request={httpMethod:'GET',headers:{'x-pilot-key':'fixture'},queryStringParameters:{version:'3',deviceStatus:'1'}};
 for(const [error,code] of [[Object.assign(Error('secret'),{code:'PERMISSION_DENIED'}),'tab5_status_denied'],[Object.assign(Error('secret'),{name:'ConfigurationError'}),'tab5_status_configuration'],[Error('secret'),'tab5_status_read_failed'],[Object.assign(Error('secret'),{code:'tab5_status_invalid'}),'tab5_status_invalid']]) {
  const handler=_createHandler({env:{PILOT_INGEST_TOKEN:'fixture'},createV3Store:()=>({}),readDeviceStatus:async()=>{throw error}});
  const response=await handler(request);assert.equal(response.statusCode,503);assert.equal(JSON.parse(response.body).code,code);assert.doesNotMatch(response.body,/secret/);
 }
 const handler=_createHandler({env:{PILOT_INGEST_TOKEN:'fixture'},createV3Store:()=>({}),readDeviceStatus:async()=>null});
 assert.equal(JSON.parse((await handler(request)).body).status,'missing');
});
