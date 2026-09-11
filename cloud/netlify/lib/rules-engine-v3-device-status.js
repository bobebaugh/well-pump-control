"use strict";
function normalizeDeviceStatus(value) {
  if (!value || value.schemaVersion!==2 || value.kind!=='rules-v3-runtime-state' || value.siteId!=='well-main' || value.deviceId!=='tab5-well-main' || typeof value.sessionId!=='string' || !value.sessionId || !Number.isInteger(value.reportedAtMs) || value.reportedAtMs<0 || typeof value.executionEnabled!=='boolean') return null;
  const ref = x => x==null || (typeof x==='object' && /^[0-9]{14}-event-v3-v[1-9][0-9]*$/.test(x.releaseId) && Number.isInteger(x.packageVersion) && x.packageVersion>0 && x.releaseId.endsWith(`-v${x.packageVersion}`) && x.runtimeSchemaVersion===3 && /^[a-f0-9]{64}$/.test(x.contentHash));
  if(!['running','desired','staged'].every(k=>ref(value[k])) || (value.executionEnabled ? value.executionState!=='running' || !value.running : value.executionState!=='unavailable' || value.running!=null)) return null;
  if(value.rejected!=null && (typeof value.rejected!=='object' || typeof value.rejected.reason!=='string')) return null;
  return {...value,running:value.running??null,desired:value.desired??null,staged:value.staged??null,rejected:value.rejected??null};
}
async function readDeviceStatus() {
  const {getDatabase} = require('firebase-admin/database');
  const {auth} = require('./firebase').getPilotAuth();
  const url = require('./rules-store')._approvedRtdbUrl(process.env.FIREBASE_RTDB_URL);
  const snapshot = await getDatabase(auth.app,url).ref('v1/sites/well-main/devices/tab5-well-main/rulesV3State').get();
  return normalizeDeviceStatus(snapshot.val());
}
module.exports={normalizeDeviceStatus,readDeviceStatus};
