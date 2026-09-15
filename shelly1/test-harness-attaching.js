// TEST HARNESS ONLY. Declares nothing and owns nothing.
//
// Runs INSTEAD of anti-chatter.js: stop that script, start this one. It stands
// in for the published contract so Tab5 and the bench page have something live
// to read and write, without the script that drives the relay being active.
//
// anti-chatter.js must remain INSTALLED. Its @meta is what provisions IsLocked,
// loCntr and Tab5IsLocked; deleting that script removes all three and this
// harness will find nothing. Stopped is enough - a declaration provisions its
// components whether or not the script ever runs.
//
// There is no component declaration here on purpose. Script.getVcHandle only
// resolves roles from the calling script's own declaration, so a second script
// that declared these names would create a SECOND set, and Tab5 rejects the
// whole acquisition when it finds any of these names twice.
//
// RELAY. This harness never reads or writes switch:0 or input:0, so while it is
// running nothing is managing RLY0. With the device set to power on with the
// output off, that means the relay stays wherever it was last left. Move it from
// the Shelly panel.
//
// Cross-script access is by RPC rather than by handle. Virtual.getHandle would
// work if the device permits it, but it has never been proven here and it is not
// needed: Shelly.getComponentStatus reads any component by key, Number.Set and
// Boolean.Set write one by id, and the components report their own id in
// config.id, so nothing has to parse a key or hard-code an id that is not stable
// across a rebuild.

let lockId = null;        // IsLocked, a number component
let countId = null;       // loCntr, a number component
let flagId = null;        // Tab5IsLocked, a boolean component

function readValue(prefix, id) {
  if (id === null) return null;
  let status = Shelly.getComponentStatus(prefix + id);
  if (status === null || status === undefined) return null;
  return status.value;
}

function setNumber(id, value) {
  if (id === null) return;
  Shelly.call("Number.Set", { id: id, value: value });
}

function setBoolean(id, value) {
  if (id === null) return;
  Shelly.call("Boolean.Set", { id: id, value: value });
}

// The countdown anti-chatter.js would be running, so a lock set from the bench
// page decays the same way the real one does. Negative means the one permanent,
// sticky lock state.
function tickIsLocked() {
  let value = readValue("number:", lockId);
  if (typeof value !== "number" || value !== value) {  // NaN fails !==
    setNumber(lockId, 0);
    return;
  }

  value = Math.floor(value);
  if (value < 0) {
    if (value !== -1) setNumber(lockId, -1);
    return;
  }

  if (value === 0) return;
  setNumber(lockId, value - 1);
}

function attach(components) {
  let i;
  for (i = 0; i < components.length; i++) {
    let entry = components[i];
    if (entry === null || entry === undefined) continue;
    if (entry.config === null || entry.config === undefined) continue;
    let id = entry.config.id;
    if (typeof id !== "number") continue;
    if (entry.config.name === "IsLocked") lockId = id;
    else if (entry.config.name === "loCntr") countId = id;
    else if (entry.config.name === "Tab5IsLocked") flagId = id;
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

    if (lockId === null || countId === null || flagId === null) {
      print("[lock-test] IsLocked/loCntr/Tab5IsLocked not all found. Is " +
            "anti-chatter.js still installed? Its @meta declares them.");
      return;
    }

    // A test run always starts clean. All three are volatile by declaration, so
    // a reboot or a restart of this harness puts the apparatus back to
    // IsLocked=0, loCntr=0, Tab5IsLocked=false.
    setNumber(lockId, 0);
    setNumber(countId, 0);
    setBoolean(flagId, false);
    Timer.set(1000, true, tickIsLocked);

    print("[lock-test] attached: IsLocked=number:" + lockId +
          " loCntr=number:" + countId + " Tab5IsLocked=boolean:" + flagId);
    print("[lock-test] IsLocked counts down once a second. RLY0 is NOT managed " +
          "while this runs - use the Shelly panel to move it.");
  }
);
