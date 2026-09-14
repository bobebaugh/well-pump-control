// @meta {"vc":{"isLocked":{"type":"number","config":{"name":"IsLocked","min":-1,"max":86400,"default_value":0,"persisted":false,"meta":{"ui":{"unit":"s","step":1}}}},"lockoutCount":{"type":"number","config":{"name":"loCntr","min":0,"max":3,"default_value":0,"persisted":false,"meta":{"ui":{"step":1}}}},"minRuntime":{"type":"number","config":{"name":"MinRuntime","min":1,"max":600,"default_value":60,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"initLockTime":{"type":"number","config":{"name":"InitLockTime","min":1,"max":86400,"default_value":90,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"maxLockoutCount":{"type":"number","config":{"name":"MaxLOcntr","min":1,"max":3,"default_value":3,"persisted":true,"meta":{"ui":{"step":1}}}},"lockoutResetTime":{"type":"number","config":{"name":"TimeToResetLOcntr","min":60,"max":86400,"default_value":3600,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}}}}

// Shelly 1 anti-chatter / short-cycle protection.
//
// The @meta line above must stay on line 1. It is what declares the six virtual
// components; with it anywhere else the handles come back undefined.
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
// STATE. Lock and strike counts are held in script variables and mirrored out to
// the virtual components. Protection therefore still works if a component is
// missing; only the reporting degrades. When a component is present its value wins,
// so correcting IsLocked by hand in the Shelly UI remains a working clear path.
//
// VOLATILITY. IsLocked and loCntr are not persisted, by design: a power cycle is a
// deliberate human act and is one of the two sanctioned ways to clear a lockout.
// The four tuning values are persisted so they survive a reboot.

let isLocked = Script.getVcHandle("isLocked");
let lockoutCount = Script.getVcHandle("lockoutCount");
let minRuntime = Script.getVcHandle("minRuntime");
let initLockTime = Script.getVcHandle("initLockTime");
let maxLockoutCount = Script.getVcHandle("maxLockoutCount");
let lockoutResetTime = Script.getVcHandle("lockoutResetTime");

let PERMANENT = -1;
let lockValue = 0;           // authoritative lock state; mirrored to IsLocked
let strikeValue = 0;         // authoritative strike count; mirrored to loCntr
let relayHeldByScript = false; // true only while this script is holding RLY0 open
let runStartMs = null;       // set on a rising SW edge, null when not running
let lastInfractionMs = null; // drives the loCntr decay window

// getVcHandle yields undefined, not null, for a component that was never
// declared, so check for both and for a usable object.
function hasHandle(handle) {
  if (handle === null || handle === undefined) return false;
  return typeof handle.setValue === "function";
}

function clamp(value, low, high) {
  if (typeof value !== "number" || value !== value) return null;  // NaN fails !==
  value = Math.floor(value);
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function readNumber(handle, fallback, low, high) {
  if (!hasHandle(handle)) return fallback;
  let value = clamp(handle.getValue(), low, high);
  if (value === null) return fallback;
  return value;
}

function writeNumber(handle, value) {
  if (hasHandle(handle)) handle.setValue(value);
}

// A present component is allowed to override the script, so a hand correction in
// the UI takes effect. A missing one leaves the script variable authoritative.
function lockState() {
  if (hasHandle(isLocked)) {
    let value = clamp(isLocked.getValue(), PERMANENT, 86400);
    if (value !== null) lockValue = value;
  }
  return lockValue;
}

function setLock(value) {
  lockValue = value;
  writeNumber(isLocked, value);
}

function strikes() {
  if (hasHandle(lockoutCount)) {
    let value = clamp(lockoutCount.getValue(), 0, 3);
    if (value !== null) strikeValue = value;
  }
  return strikeValue;
}

function setStrikes(value) {
  strikeValue = value;
  writeNumber(lockoutCount, value);
}

// This script may only ever OPEN the relay. Tab5 opens RLY0 for its own inhibits,
// and anything here that asserts it closed would undo them - once a second, for as
// long as Tab5 kept trying. So the only close performed is the release of a hold
// this script placed itself, tracked by relayHeldByScript.
function relayIsClosed() {
  let status = Shelly.getComponentStatus("switch:0");
  return status !== null && status !== undefined && status.output === true;
}

function openRelay() {
  relayHeldByScript = true;
  if (relayIsClosed()) Shelly.call("Switch.Set", { id: 0, on: false });
}

function releaseRelay() {
  relayHeldByScript = false;
  Shelly.call("Switch.Set", { id: 0, on: true });
}

function recordInfraction() {
  let count = strikes() + 1;
  if (count > 3) count = 3;
  setStrikes(count);
  lastInfractionMs = Date.now();
  if (count >= readNumber(maxLockoutCount, 3, 1, 3)) {
    setLock(PERMANENT);
    print("[anti-chatter] STRIKEOUT: loCntr=" + count + "; RLY0 open until reboot");
  } else {
    let hold = readNumber(initLockTime, 90, 1, 86400);
    setLock(hold);
    print("[anti-chatter] strike " + count + "; RLY0 open for " + hold + "s");
  }
  openRelay();
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
  if (lockState() !== 0) return;
  let ranS = Math.floor(ranMs / 1000);
  if (ranS < readNumber(minRuntime, 60, 1, 600)) {
    print("[anti-chatter] short cycle: " + ranS + "s");
    recordInfraction();
  }
}

function tick() {
  let lock = lockState();

  if (lock > 0) {
    setLock(lock - 1);
    if (lockValue === 0) print("[anti-chatter] lock expired; RLY0 closing");
  } else if (lock < 0 && lock !== PERMANENT) {
    setLock(PERMANENT);  // a permanent lock is sticky; normalize any other negative
  }

  // Relay action is driven by this script's own hold, never by the lock value
  // alone. When unlocked it does nothing at all, leaving RLY0 to Tab5.
  if (lockValue === 0) {
    if (relayHeldByScript) releaseRelay();
  } else if (relayIsClosed()) {
    openRelay();  // re-assert only while locked, where this script has authority
  }

  if (lockValue === 0 && strikes() > 0 && lastInfractionMs !== null) {
    let window = readNumber(lockoutResetTime, 3600, 60, 86400) * 1000;
    if (Date.now() - lastInfractionMs >= window) {
      setStrikes(0);
      lastInfractionMs = null;
      print("[anti-chatter] clean period elapsed; loCntr reset");
    }
  }
}

Shelly.addStatusHandler(function (event) {
  if (event.component !== "input:0") return;
  if (event.delta === undefined || typeof event.delta.state !== "boolean") return;
  if (event.delta.state === true) pumpStarted();
  else pumpStopped();
});

// Report missing components loudly. Protection continues either way, but Tab5
// rejects the whole acquisition if either contract component is absent.
if (!hasHandle(isLocked) || !hasHandle(lockoutCount)) {
  print("[anti-chatter] WARNING: IsLocked/loCntr handles unavailable. " +
        "Protection is active but nothing is published to Tab5. Check that the " +
        "@meta line is line 1 and that no other script owns these names.");
}

// Volatile by design: a reboot is a sanctioned clear, so start from a known
// unlocked state with the relay closed and no run in progress.
setLock(0);
setStrikes(0);

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
