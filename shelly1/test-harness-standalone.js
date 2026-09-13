// @meta {"vc":{"isLocked":{"type":"number","config":{"name":"IsLocked","min":-1,"max":86400,"default_value":0,"persisted":false,"meta":{"ui":{"unit":"s","step":1}}}},"lockoutCount":{"type":"number","config":{"name":"loCntr","min":0,"max":3,"default_value":0,"persisted":false,"meta":{"ui":{"step":1}}}}}}
//
// TEST HARNESS ONLY — it deliberately does not read or write switch:0 or input:0.
// It supplies two temporary script-owned values for Tab5 and browser integration
// testing. Starting/restarting the script resets both values to zero.

let isLocked = Script.getVcHandle("isLocked");
let lockoutCount = Script.getVcHandle("lockoutCount");

function writeValue(component, value) {
  if (component !== null) component.setValue(value);
}

function tickIsLocked() {
  if (isLocked === null) return;

  let value = isLocked.getValue();
  if (typeof value !== "number" || value !== value) {
    writeValue(isLocked, 0);
    return;
  }

  value = Math.floor(value);
  if (value < 0) {
    // Any negative test input means the one permanent, sticky lock state.
    if (value !== -1) writeValue(isLocked, -1);
    return;
  }

  if (value === 0) return;
  writeValue(isLocked, value - 1);
}

// A test run is always clean.  The values are intentionally volatile: a Shelly
// reboot or script restart starts the test apparatus at IsLocked=0, loCntr=0.
writeValue(isLocked, 0);
writeValue(lockoutCount, 0);
Timer.set(1000, true, tickIsLocked);
