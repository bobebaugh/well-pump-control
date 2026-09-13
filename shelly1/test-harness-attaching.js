// TEST HARNESS ONLY. Declares nothing and owns nothing.
//
// It attaches to the IsLocked and loCntr components declared by
// anti-chatter.js, so that script must exist on the device. It deliberately
// does not read or write switch:0 or input:0, and it never touches the relay.
//
// PAUSE anti-chatter.js BEFORE STARTING THIS. Both scripts tick IsLocked down
// once a second, so running them together halves every lock: a 90-second hold
// releases in 45.
//
// There is no component declaration here on purpose. Script.getVcHandle only
// resolves roles from the calling script's own declaration, so a second script
// that declared these names would create a second set of components -- and Tab5
// rejects the whole acquisition when it finds either name twice. Cross-script
// access is Virtual.getHandle instead, with the component key resolved by name
// because the numeric id is assigned at creation and is not stable across a
// rebuild. This is the same discovery Tab5 performs, using the same RPC.

let isLocked = null;
let lockoutCount = null;

function writeValue(handle, value) {
  if (handle !== null && handle !== undefined) handle.setValue(value);
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

function attach(components) {
  let i;
  for (i = 0; i < components.length; i++) {
    let entry = components[i];
    if (entry === null || entry === undefined) continue;
    if (entry.config === null || entry.config === undefined) continue;
    if (entry.config.name === "IsLocked") isLocked = Virtual.getHandle(entry.key);
    else if (entry.config.name === "loCntr") lockoutCount = Virtual.getHandle(entry.key);
  }
}

Shelly.call(
  "Shelly.GetComponents",
  { dynamic_only: true, include: ["config", "status"] },
  function (result, code, message) {
    if (code !== 0 || result === null || result === undefined ||
        result.components === null || result.components === undefined) {
      print("[lock-test] component discovery failed: " + code + " " + message);
      return;
    }

    attach(result.components);

    if (isLocked === null || lockoutCount === null) {
      print("[lock-test] IsLocked/loCntr not found. Is anti-chatter.js installed?");
      return;
    }

    // A test run always starts clean. The values are intentionally volatile: a
    // reboot or restart puts the apparatus back at IsLocked=0, loCntr=0.
    writeValue(isLocked, 0);
    writeValue(lockoutCount, 0);
    Timer.set(1000, true, tickIsLocked);
    print("[lock-test] attached; IsLocked counts down once a second");
  }
);
