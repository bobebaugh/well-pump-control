"use strict";
const SECTIONS = ['devices', 'calculatedFields', 'systemFields', 'events'];
const KIND = 'well-pump-rules-authoring-backup';
// Shape validation protects the editor without requiring an unfinished draft to compile.
function authoringShape(draft) {
  const errors = [];
  const fail = (path, message) => errors.push({path, code:'invalid_authoring_shape', message});
  const object = (v, p, keys, optional = []) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { fail(p,'Expected an object.'); return false; }
    for (const k of keys) if (!Object.hasOwn(v,k)) fail(`${p}.${k}`, 'Required property is missing.');
    for (const k of Object.keys(v)) if (![...keys,...optional].includes(k)) fail(`${p}.${k}`, 'Unrecognized authoring property.');
    return true;
  };
  const scalar = (v,p,type) => { if (!(type === 'nullableString' ? v === null || typeof v === 'string' : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type)) fail(p,`Expected ${type}.`); };
  const array = (v,p,each,max=256) => { if (!Array.isArray(v) || v.length>max) { fail(p,`Expected an array with at most ${max} items.`); return; } v.forEach((x,i)=>each(x,`${p}[${i}]`)); };
  const logging = (v,p) => {if(object(v,p,['mode'],['threshold'])) {scalar(v.mode,`${p}.mode`,'string'); if(Object.hasOwn(v,'threshold')) scalar(v.threshold,`${p}.threshold`,'number');}};
  const field = (v,p,direct=false) => {
    if (!object(v,p,['systemName','label','type','unit','logging',...(direct?['object','access']:[])],['enumValues',...(direct?['write']:[])])) return;
    for(const k of ['systemName','label','type',...(direct?['object','access']:[])]) scalar(v[k],`${p}.${k}`,'string');
    scalar(v.unit,`${p}.unit`,'nullableString'); logging(v.logging,`${p}.logging`);
    if(v.enumValues!==undefined) array(v.enumValues,`${p}.enumValues`,(x,p)=>scalar(x,p,'string'),32);
    if(v.write!==undefined && object(v.write,`${p}.write`,['method','parameters','normalValue'])) {scalar(v.write.method,`${p}.write.method`,'string'); if(!v.write.parameters || typeof v.write.parameters!=='object' || Array.isArray(v.write.parameters)) fail(`${p}.write.parameters`,'Expected argument object.');}
  };
  const condition = (v,p,qualified=true) => {
    if(!object(v,p,['mode','clauses',...(qualified?['observationCount','minimumSeconds']:[])])) return;
    scalar(v.mode,`${p}.mode`,'string');
    if(qualified) for(const k of ['observationCount','minimumSeconds']) scalar(v[k],`${p}.${k}`,'number');
    array(v.clauses,`${p}.clauses`,(x,p)=>{if(object(x,p,['field','operator','value'])) {scalar(x.field,`${p}.field`,'string');scalar(x.operator,`${p}.operator`,'string');}},16);
  };
  const assignment=(v,p)=>{if(object(v,p,['target','value','ownership'])) {scalar(v.target,`${p}.target`,'string');scalar(v.ownership,`${p}.ownership`,'string');}};
  const phase=(v,p)=>{if(object(v,p,['assignments','guardedGroups'])) {array(v.assignments,`${p}.assignments`,assignment,32);array(v.guardedGroups,`${p}.guardedGroups`,(g,p)=>{if(object(g,p,['guard','assignments'])) {condition(g.guard,`${p}.guard`,false);array(g.assignments,`${p}.assignments`,assignment,32);}},16);}};
  if(!object(draft,'',['schemaVersion',...SECTIONS])) return errors;
  if(draft.schemaVersion!==3) fail('schemaVersion','Only V3 authoring configurations are accepted. Runtime JSON and V2 backups cannot be restored here.');
  array(draft.devices,'devices',(d,p)=>{if(object(d,p,['id','label','driver','address','enabled','fields'])) {for(const k of ['id','label','driver','address']) scalar(d[k],`${p}.${k}`,'string');scalar(d.enabled,`${p}.enabled`,'boolean');array(d.fields,`${p}.fields`,(f,p)=>field(f,p,true),32);}},16);
  array(draft.calculatedFields,'calculatedFields',(c,p)=>{
    if(!c || !['expression','function'].includes(c.kind)) {fail(p,'Calculation kind must be expression or function.');return;}
    if(!object(c,p,['id','label','kind',...(c.kind==='expression'?['expression','output']:['functionId','inputs','parameters','outputs'])])) return;
    for(const k of ['id','label','kind']) scalar(c[k],`${p}.${k}`,'string');
    if(c.kind==='expression') {scalar(c.expression,`${p}.expression`,'string');field(c.output,`${p}.output`);}
    else {scalar(c.functionId,`${p}.functionId`,'string');if(object(c.inputs,`${p}.inputs`,['pressure'])) scalar(c.inputs.pressure,`${p}.inputs.pressure`,'string');if(object(c.parameters,`${p}.parameters`,['effectiveTankGallons','prechargeGaugePsi','atmosphericPressurePsi','regressionWindowSeconds','minimumSamples'])) for(const [k,v] of Object.entries(c.parameters)) scalar(v,`${p}.parameters.${k}`,'number');array(c.outputs,`${p}.outputs`,field,5);}
  },64);
  array(draft.systemFields,'systemFields',(f,p)=>{
    if(!object(f,p,['id','systemName','label','source','runtimeRole','type','unit','logging'],['initialValue','assignmentTarget','enumValues','occurrenceKey'])) return;
    for(const k of ['id','systemName','label','source','runtimeRole','type']) scalar(f[k],`${p}.${k}`,'string');
    scalar(f.unit,`${p}.unit`,'nullableString');logging(f.logging,`${p}.logging`);
    if(f.enumValues!==undefined) array(f.enumValues,`${p}.enumValues`,(x,p)=>scalar(x,p,'string'),32);
    if(f.source==='session') {if(!Object.hasOwn(f,'initialValue')) fail(`${p}.initialValue`,'Startup value is required.');scalar(f.assignmentTarget,`${p}.assignmentTarget`,'boolean');}
    else scalar(f.occurrenceKey,`${p}.occurrenceKey`,'string');
  },32);
  array(draft.events,'events',(e,p)=>{
    if(!object(e,p,['id','systemName','displayName','enabled','severity','eventClass','opening','closing','onOpen','onClose','summary','web'])) return;
    for(const k of ['id','systemName','displayName','severity','eventClass']) scalar(e[k],`${p}.${k}`,'string');scalar(e.enabled,`${p}.enabled`,'boolean');
    if(object(e.opening,`${p}.opening`,['trigger'])) {const t=e.opening.trigger;if(t?.type==='condition') {if(object(t,`${p}.opening.trigger`,['type','condition'])) condition(t.condition,`${p}.opening.trigger.condition`);} else if(object(t,`${p}.opening.trigger`,['type','occurrenceField','qualification'])) {scalar(t.type,`${p}.opening.trigger.type`,'string');scalar(t.occurrenceField,`${p}.opening.trigger.occurrenceField`,'string');if(object(t.qualification,`${p}.opening.trigger.qualification`,['observationCount','minimumSeconds'])) for(const k of ['observationCount','minimumSeconds']) scalar(t.qualification[k],`${p}.opening.trigger.qualification.${k}`,'number');}}
    if(object(e.closing,`${p}.closing`,['policy'],['condition'])) {scalar(e.closing.policy,`${p}.closing.policy`,'string');if(e.closing.policy==='condition') condition(e.closing.condition,`${p}.closing.condition`);}
    phase(e.onOpen,`${p}.onOpen`);phase(e.onClose,`${p}.onClose`);
    if(object(e.summary,`${p}.summary`,['durationOutput','aggregates'])) {if(e.summary.durationOutput!==null) field(e.summary.durationOutput,`${p}.summary.durationOutput`);array(e.summary.aggregates,`${p}.summary.aggregates`,(a,p)=>{if(object(a,p,['source','operation','scale','output'])) {scalar(a.source,`${p}.source`,'string');scalar(a.operation,`${p}.operation`,'string');scalar(a.scale,`${p}.scale`,'number');field(a.output,`${p}.output`);}},32);}
    if(object(e.web,`${p}.web`,['notifyOnOpen','notifyOnClose','openMessage','closeMessage'])) {for(const k of ['notifyOnOpen','notifyOnClose']) scalar(e.web[k],`${p}.web.${k}`,'boolean');for(const k of ['openMessage','closeMessage']) scalar(e.web[k],`${p}.web.${k}`,'string');}
  },64);
  return errors;
}
function makeBackup(draft) { return {kind:KIND,backupVersion:1,authoringPackage:{schemaVersion:3,...Object.fromEntries(SECTIONS.map(s=>[s,draft[s]]))}}; }
function readBackup(value) {
  if(!value || value.kind!==KIND || value.backupVersion!==1 || Object.keys(value).some(k=>!['kind','backupVersion','authoringPackage'].includes(k))) return {errors:[{path:'backup',code:'invalid_backup',message:'Choose a complete authoring backup (backupVersion 1). Runtime downloads and V2 files are not editable backups.'}]};
  return {draft:value.authoringPackage,errors:authoringShape(value.authoringPackage)};
}
module.exports={SECTIONS,KIND,authoringShape,makeBackup,readBackup};
