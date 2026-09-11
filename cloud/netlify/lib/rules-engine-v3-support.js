"use strict";

// Executable subset reviewed against Tab5 M6.33 (6d4b54cc), not a new runtime.
const { FUNCTION_CATALOG } = require('./rules-engine-defaults');
function runtimeSupport(draft, runtime) {
  const errors = [], warnings = [];
  const issue = (path, message) => errors.push({ path, code: 'tab5_unsupported', message });
  const fields = new Map();
  for (const device of draft.devices) for (const field of device.fields) fields.set(field.systemName, field);
  for (const field of draft.systemFields) fields.set(field.systemName, field);
  const relayFields = draft.devices.flatMap((d,i)=>d.fields.map((f,j)=>({d,f,path:`devices[${i}].fields[${j}]`}))).filter(x=>x.f.access==='readWrite');
  for(const {f,path} of relayFields) {
    if(f.systemName!=='PumpEnable') issue(`${path}.systemName`, 'The current Tab5 relay ownership logic requires the system name PumpEnable.');
    const lock=draft.devices.some(d=>d.driver==='shelly-gen4-switch' && d.fields.some(f=>f.object==='UDF(IsLocked)' && f.systemName==='IsLocked'));
    if(!lock) issue(path, 'Relay restoration requires the IsLocked integer field mapped to UDF(IsLocked).');
  }
  const tab5 = draft.devices.filter(d => d.driver === 'tab5-runtime').flatMap(d => d.fields);
  for (const [i, calculation] of draft.calculatedFields.entries()) {
    const path = `calculatedFields[${i}]`;
    const compiled = runtime.calculations.find(c => c.id === calculation.id);
    const outputs = calculation.kind === 'expression' ? [calculation.output] : calculation.outputs;
    for (const output of outputs) fields.set(output.systemName, output);
    if (calculation.kind === 'expression') {
      if (calculation.output.type !== 'number') issue(`${path}.output.type`, 'Tab5 arithmetic expressions require a number output, not integer.');
      if (compiled.program.some(t => t[0] === 'operator' && t[1] === 'neg')) issue(`${path}.expression`, 'Tab5 does not support unary minus. Write subtraction, for example (0 - PumpWatts).');
      if (compiled.program.some(t => t[0] === 'number' && !Number.isFinite(t[1]))) issue(`${path}.expression`, 'Expression constants must be finite numbers.');
      const adc = tab5.find(f => f.object === 'values.adc_raw');
      if (adc && compiled.program.some(t => t[0] === 'field' && t[1] === adc.systemName)) {
        for (const object of ['status.pressure_sensor_commissioned', 'status.adc_available']) {
          if (!tab5.some(f => f.object === object)) issue(`${path}.expression`, `ADC calculations require the Tab5 field ${object}.`);
        }
      }
    } else {
      const p = calculation.parameters;
      for (const key of ['effectiveTankGallons', 'atmosphericPressurePsi', 'regressionWindowSeconds']) if (!(p[key] > 0)) issue(`${path}.parameters.${key}`, `${key} must be greater than zero for Tab5.`);
      if (!Number.isInteger(p.minimumSamples) || p.minimumSamples < 2) issue(`${path}.parameters.minimumSamples`, 'Minimum samples must be an integer of at least 2.');
      if(p.prechargeGaugePsi + p.atmosphericPressurePsi <= 0) issue(`${path}.parameters.prechargeGaugePsi`, 'Precharge plus atmospheric pressure must be greater than zero.');
      if(p.regressionWindowSeconds > 0 && p.regressionWindowSeconds < 0.001) issue(`${path}.parameters.regressionWindowSeconds`, 'Regression window must be at least one millisecond.');
      const expected = FUNCTION_CATALOG.boyle_tank.outputs[4].enumValues;
      const actual = calculation.outputs[4].enumValues;
      if (!Array.isArray(actual) || actual.length !== expected.length || expected.some(v => !actual.includes(v))) issue(`${path}.outputs[4].enumValues`, `Tank quality choices must be: ${expected.join(', ')}.`);
      if (Object.keys(calculation.inputs).some(k => k !== 'pressure')) issue(`${path}.inputs`, 'Boyle inputs contain only pressure.');
      if (Object.keys(p).some(k => !Object.hasOwn(FUNCTION_CATALOG.boyle_tank.parameters, k))) issue(`${path}.parameters`, 'Remove unrecognized Boyle parameters.');
    }
    outputs.forEach((f, j) => {
      const p = calculation.kind === 'expression' ? `${path}.output` : `${path}.outputs[${j}]`;
      if (f.type !== 'enum' && f.enumValues != null) issue(`${p}.enumValues`, 'Enum choices belong only to enum fields.');
      if (f.type === 'enum' && (!Array.isArray(f.enumValues) || f.enumValues.length > 32 || f.enumValues.some(v => typeof v !== 'string' || !v) || new Set(f.enumValues).size !== f.enumValues.length)) issue(`${p}.enumValues`, 'Use 2–32 distinct, nonempty enum choices.');
    });
  }
  draft.events.forEach((event, i) => {
    const path = `events[${i}]`;
    if (event.displayName.length > 160) issue(`${path}.displayName`, 'Tab5 event display names are limited to 160 characters.');
    if (event.summary.durationOutput !== null) issue(`${path}.summary.durationOutput`, 'Tab5 does not execute duration outputs yet. Clear Store event duration before publishing; the saved backup can retain it.');
    event.summary.aggregates.forEach((_, j) => issue(`${path}.summary.aggregates[${j}]`, 'Tab5 does not execute summary aggregates yet. Remove this summary row before publishing.'));
    if (event.opening.trigger.type !== 'condition' || event.closing.policy === 'clearEvents') warnings.push({path, code: 'input_not_connected', message: 'The kernel supports this declaration, but operator/internal occurrences and Clear Events inputs are not yet connected. This event may not open or close as intended.'});
    if (event.web.notifyOnOpen || event.web.notifyOnClose) warnings.push({path: `${path}.web`, code: 'notifications_authoring_only', message: 'Notification settings are retained authoring data; notification delivery is not implemented.'});
    for (const phase of ['onOpen', 'onClose']) {
      const check = (a, p) => {
        const target = fields.get(a.target);
        if (target?.runtimeRole === 'operatingMode') {
          if (event.eventClass !== 'monitor' || a.value !== 'Monitor' || a.ownership !== 'whileOpen' || phase !== 'onOpen') issue(p, 'Operating mode may only be held at Monitor by a Monitor event on opening. Normal returns when the final owner closes.');
        } else if (event.eventClass === 'monitor') issue(p, 'Monitor events may assign only the operating-mode field.');
        if (target?.type === 'integer' && !Number.isInteger(a.value)) issue(`${p}.value`, 'An integer assignment requires a whole number.');
      };
      event[phase].assignments.forEach((a, j) => check(a, `${path}.${phase}.assignments[${j}]`));
      event[phase].guardedGroups.forEach((g, j) => g.assignments.forEach((a, k) => check(a, `${path}.${phase}.guardedGroups[${j}].assignments[${k}]`)));
    }
    const conditions = [event.opening.trigger.condition, event.closing.condition, ...['onOpen','onClose'].flatMap(p => event[p].guardedGroups.map(g => g.guard))];
    conditions.filter(Boolean).forEach(c => c.clauses.forEach(clause => {
      if (fields.get(clause.field)?.type === 'integer' && ['eq','neq','changes'].includes(clause.operator) && !Number.isInteger(clause.value)) issue(path, `Comparison with integer field ${clause.field} requires a whole number.`);
    }));
  });
  return {errors, warnings};
}
module.exports = {runtimeSupport};
