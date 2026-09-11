'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {defaults}=require('../cloud/netlify/lib/rules-engine-v3-defaults');
const {validateAndCompileV3}=require('../cloud/netlify/lib/rules-engine-v3-contract');
const {runtimeSupport}=require('../cloud/netlify/lib/rules-engine-v3-support');
const {readBackup,makeBackup}=require('../cloud/netlify/lib/rules-engine-v3-backup');
const cases=[
 ['baseline',()=>{},true],
 ['zero tank',d=>d.calculatedFields[2].parameters.effectiveTankGallons=0,false],
 ['fractional samples',d=>d.calculatedFields[2].parameters.minimumSamples=2.5,false],
 ['negative window',d=>d.calculatedFields[2].parameters.regressionWindowSeconds=-1,false],
 ['quality choices',d=>d.calculatedFields[2].outputs[4].enumValues=['A','B'],false],
 ['missing ADC guard',d=>d.devices[2].fields=d.devices[2].fields.filter(f=>f.object!=='status.adc_available'),false],
 ['unary minus',d=>d.calculatedFields[1].expression='-PumpWatts',false],
 ['integer expression',d=>d.calculatedFields[1].output.type='integer',false],
 ['overflow constant',d=>d.calculatedFields[1].expression='1e999',false],
 ['long event title',d=>d.events[0].displayName='X'.repeat(161),false],
 ['duration',d=>d.events[0].summary.durationOutput={systemName:'Duration',label:'Duration',type:'number',unit:'s',logging:{mode:'none'}},false],
 ['aggregate',d=>d.events[0].summary.aggregates=[{source:'PumpWatts',operation:'end',scale:1,output:{systemName:'Summary',label:'Summary',type:'number',unit:'W',logging:{mode:'none'}}}],false],
 ['disabled unsupported duration',d=>{d.events[0].enabled=false;d.events[0].summary.durationOutput={systemName:'Duration',label:'Duration',type:'number',unit:'s',logging:{mode:'none'}};},false],
 ['custom closing policy',d=>{d.events[0].closing.condition.clauses[0].value=244;},true],
 ['subtraction',d=>d.calculatedFields[1].expression='0 - PumpWatts',true],
 ['working integer',d=>d.systemFields.push({id:'counter',systemName:'Counter',label:'Counter',source:'session',runtimeRole:'working',type:'integer',unit:null,logging:{mode:'change'},initialValue:0,assignmentTarget:true}),true],
 ['wrong mode assignment',d=>{d.events[0].onOpen.assignments=[{target:'OperatingMode',value:'Normal',ownership:'transition'}];},false],
];
test('online compatibility agrees with the pinned real Tab5 resolver on representative packages',()=>{
 const candidates=[];
 for(const [name,mutate,expected] of cases) {
   const draft=defaults(); mutate(draft);
   const online=validateAndCompileV3(draft);
   assert.equal(online.valid,expected,`${name}: ${JSON.stringify(online.errors)}`);
   assert.deepEqual(readBackup(makeBackup(draft)).draft,draft,`${name}: backup preserves authoring`);
   const authoring=validateAndCompileV3(draft,{authoringOnly:true});
   if(authoring.valid) candidates.push({name,expected,package:{...authoring.runtimePackage,releaseId:'20260911000000-event-v3-v1',packageVersion:1}});
 }
 const run=spawnSync('python3',[require('node:path').join(__dirname,'fixtures/tab5-v3-resolver-m633.py')],{input:JSON.stringify(candidates.map(c=>c.package)),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const outcomes=JSON.parse(run.stdout);
 candidates.forEach((c,i)=>assert.equal(outcomes[i],c.expected,`Tab5: ${c.name}`));
});
test('known invalid driver/write bindings are rejected online',()=>{
 for(const mutate of [d=>d.devices[0].driver='unknown',d=>d.devices[1].fields.find(f=>f.access==='readWrite').write.method='Switch.Toggle',d=>d.devices[1].fields.find(f=>f.access==='readWrite').write.normalValue=false]) {
   const d=defaults();mutate(d);assert.equal(validateAndCompileV3(d).valid,false);
 }
});
