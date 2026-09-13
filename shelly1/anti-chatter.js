// Shelly 1 anti-chatter / short-cycle protection.
//
// AUTHORITY. This script owns RLY0 and sits above Tab5. Tab5 reads IsLocked and
// loCntr and must never write, clear, or work around them. Nothing here starts a
// pump: RLY0 is one series element in the automation-controlled G/B- loop, so the
// only thing this script can do is refuse to complete that loop. The pressure
// switch on the B+ side, the 3-second on-delay, the 6-minute max-runtime limit,
// and the HAND bypass all remain in front of it and are unaffected.
//
// SENSING. SW senses ground at the contactor, downstream of RLY0 and the original
// automation, so a rising edge means the pump actually started and a falling edge
// means it actually stopped. In HAND the loop is hard-wired and SW sits high
// continuously, producing no falling edge and therefore no strike.
//
// RULE. A pump run shorter than MinRuntime is an infraction: open RLY0, increment
// loCntr, and hold IsLocked for InitLockTime seconds. At MaxLOcntr infractions the
// lock becomes permanent (-1) and RLY0 stays open until the device reboots. loCntr
// decays to zero after TimeToResetLOcntr seconds without a further infraction.
//
// This is deliberately reactive, not pre-emptive. The first short cycle reaches the
// pump; every one after it is blocked, because InitLockTime is far longer than any
// enforced idle would have been. The original 3-second delay remains the only thing
// in front of the first event, which is what it has always been.
//
// VOLATILITY. IsLocked and loCntr are not persisted, by design: a power cycle is a
// deliberate human act and is one of the two sanctioned ways to clear a lockout.
// The four tuning values are persisted so they survive a reboot.

// @meta {"vc":{"isLocked":{"type":"number","config":{"name":"IsLocked","min":-1,"max":86400,"default_value":0,"persisted":false,"meta":{"ui":{"unit":"s","step":1}}}},"lockoutCount":{"type":"number","config":{"name":"loCntr","min":0,"max":3,"default_value":0,"persisted":false,"meta":{"ui":{"step":1}}}},"minRuntime":{"type":"number","config":{"name":"MinRuntime","min":1,"max":600,"default_value":60,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"initLockTime":{"type":"number","config":{"name":"InitLockTime","min":1,"max":86400,"default_value":90,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"maxLockoutCount":{"type":"number","config":{"name":"MaxLOcntr","min":1,"max":3,"default_value":3,"persisted":true,"meta":{"ui":{"step":1}}}},"lockoutResetTime":{"type":"number","config":{"name":"TimeToResetLOcntr","min":60,"max":86400,"default_value":3600,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}}}}

let isLocked = Script.getVcHandle("isLocked");
let lockoutCount = Script.getVcHandle("lockoutCount");
let minRuntime = Script.getVcHandle("minRuntime");
let initLockTime = Script.getVcHandle("initLockTime");
let maxLockoutCount = Script.getVcHandle("maxLockoutCount");
let lockoutResetTime = Script.getVcHandle("lockoutResetTime");

let PERMANENT = -1;
let runStartMs = null;      // set on a rising SW edge, null when not running
let lastInfractionMs = null; // drives the loCntr decay window

function readNumber(handle, fallback, low, high) {
  if (handle === null) return fallback;
  let value = handle.getValue();
  // NaN fails value !== value; a missing or non-numeric value falls back.
  if (typeof value !== "number" || value !== value) return fallback;
  value = Math.floor(value);
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function writeNumber(handle, value) {
  if (handle !== null) handle.setValue(value);
}

function lockState() {
  return readNumber(isLocked, 0, PERMANENT, 86400);
}

function strikes() {
  return readNumber(lockoutCount, 0, 0, 3);
}

// The relay is driven from the lock value rather than from the event that set it,
// so the two can never disagree and a manual correction of IsLocked in the Shelly
// UI is itself a working clear path.
function applyRelay() {
  let shouldClose = lockState() === 0;
  let status = Shelly.getComponentStatus("switch:0");
  let isClosed = status !== null && status !== undefined && status.output === true;
  if (isClosed !== shouldClose) {
    Shelly.call("Switch.Set", { id: 0, on: shouldClose });
  }
}

function recordInfraction() {
  let count = strikes() + 1;
  let limit = readNumber(maxLockoutCount, 3, 1, 3);
  if (count > 3) count = 3;
  writeNumber(lockoutCount, count);
  lastInfractionMs = Date.now();
  if (count >= limit) {
    writeNumber(isLocked, PERMANENT);
    print("[anti-chatter] STRIKEOUT: loCntr=" + count + "; RLY0 open until reboot");
  } else {
    let hold = readNumber(initLockTime, 90, 1, 86400);
    writeNumber(isLocked, hold);
    print("[anti-chatter] strike " + count + "; RLY0 open for " + hold + "s");
  }
  applyRelay();
}

function pumpStarted() {
  // While locked, RLY0 is open and the contactor cannot be energized. Any edge
  // seen in that state is not a pump start, so it must not begin a run.
  if (lockState() !== 0) return;
  runStartMs = Date.now();
}

function pumpStopped() {
  if (runStartMs === null) return;
  let ranMs = Date.now() - runStartMs;
  runStartMs = null;
  if (ranMs < 0) return;  // clock moved; discard rather than invent an infraction
  let ranS = Math.floor(ranMs / 1000);
  if (lockState() !== 0) return;
  if (ranS < readNumber(minRuntime, 60, 1, 600)) {
    print("[anti-chatter] short cycle: " + ranS + "s");
    recordInfraction();
  }
}

function onInput(state) {
  if (state === true) pumpStarted();
  else pumpStopped();
}

function tick() {
  let lock = lockState();

  if (lock > 0) {
    lock = lock - 1;
    writeNumber(isLocked, lock);
    if (lock === 0) print("[anti-chatter] lock expired; RLY0 closing");
  }

  // A permanent lock is sticky: normalize any other negative value onto -1.
  if (lock < 0 && lock !== PERMANENT) {
    writeNumber(isLocked, PERMANENT);
    lock = PERMANENT;
  }

  if (lock === 0 && strikes() > 0 && lastInfractionMs !== null) {
    let window = readNumber(lockoutResetTime, 3600, 60, 86400) * 1000;
    if (Date.now() - lastInfractionMs >= window) {
      writeNumber(lockoutCount, 0);
      lastInfractionMs = null;
      print("[anti-chatter] clean period elapsed; loCntr reset");
    }
  }

  applyRelay();
}

Shelly.addStatusHandler(function (event) {
  if (event.component !== "input:0") return;
  if (event.delta === undefined || typeof event.delta.state !== "boolean") return;
  onInput(event.delta.state);
});

// Volatile by design: a reboot is a sanctioned clear, so start from a known
// unlocked state with the relay closed and no run in progress.
writeNumber(isLocked, 0);
writeNumber(lockoutCount, 0);
applyRelay();

let initial = Shelly.getComponentStatus("input:0");
if (initial !== null && initial !== undefined && initial.state === true) {
  // Already energized at start: treat it as a run beginning now rather than
  // guessing how long it has been running.
  runStartMs = Date.now();
}

Timer.set(1000, true, tick);
print("[anti-chatter] started; MinRuntime=" + readNumber(minRuntime, 60, 1, 600) +
      "s InitLockTime=" + readNumber(initLockTime, 90, 1, 86400) +
      "s MaxLOcntr=" + readNumber(maxLockoutCount, 3, 1, 3) +
      " TimeToResetLOcntr=" + readNumber(lockoutResetTime, 3600, 60, 86400) + "s");
