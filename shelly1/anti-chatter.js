// @meta {"vc":{"isLocked":{"type":"number","config":{"name":"IsLocked","min":-1,"max":86400,"default_value":0,"persisted":false,"meta":{"ui":{"unit":"s","step":1}}}},"lockoutCount":{"type":"number","config":{"name":"loCntr","min":0,"max":3,"default_value":0,"persisted":false,"meta":{"ui":{"step":1}}}},"minRuntime":{"type":"number","config":{"name":"MinRuntime","min":1,"max":600,"default_value":60,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"initLockTime":{"type":"number","config":{"name":"InitLockTime","min":1,"max":86400,"default_value":90,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"maxLockoutCount":{"type":"number","config":{"name":"MaxLOcntr","min":1,"max":3,"default_value":3,"persisted":true,"meta":{"ui":{"step":1}}}},"lockoutResetTime":{"type":"number","config":{"name":"TimeToResetLOcntr","min":60,"max":86400,"default_value":3600,"persisted":true,"meta":{"ui":{"unit":"s","step":1}}}},"tab5IsLocked":{"type":"boolean","config":{"name":"Tab5IsLocked","default_value":false,"persisted":false}}}}

// Shelly 1 anti-chatter / short-cycle protection.
//
// The @meta line above must stay on line 1. It is what declares the six virtual
// components; with it anywhere else the handles come back undefined.
//
// AUTHORITY. This script is the sole writer of RLY0 and sits above Tab5. Tab5 reads
// IsLocked and loCntr and must never write, clear, or work around them; it publishes
// its own inhibition as the Tab5IsLocked boolean, which this script reads and never
// writes. Nothing here starts a pump: RLY0 is one series element in the
// automation-controlled G/B- loop, so the only thing this script can do is refuse to
// complete that loop. The pressure switch on the B+ side, the 3-second on-delay, the
// 6-minute max-runtime limit, and the HAND bypass all remain in front of it and are
// unaffected.
//
// RELAY POLICY. RLY0 is closed exactly when IsLocked == 0 AND Tab5IsLocked == false,
// and open otherwise. The policy is applied against the observed output, so steady
// state costs no Switch.Set call and each transition costs exactly one. A missing or
// unusable Tab5IsLocked handle removes Tab5's contribution only - it can never clear
// or override this script's own lock.
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
let tab5IsLocked = Script.getVcHandle("tab5IsLocked");

let PERMANENT = -1;
let lockValue = 0;           // authoritative lock state; mirrored to IsLocked
let strikeValue = 0;         // authoritative strike count; mirrored to loCntr
let relayOpenByScript = false;  // true while this script is holding RLY0 open
let relayOpenForTab5 = false;  // true when that hold is applying Tab5's inhibition
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

// Tab5's published inhibition request. A missing or unusable handle contributes
// nothing rather than a guessed hold, and can never clear this script's own lock.
function tab5Intent() {
  if (!hasHandle(tab5IsLocked)) return false;
  return tab5IsLocked.getValue() === true;
}

// Tri-state on purpose: null means the output was not readable this pass. The
// policy acts only on a definite mismatch, so unknown evidence never produces a
// relay call and never invents an observed position.
function relayOutput() {
  let status = Shelly.getComponentStatus("switch:0");
  if (status === null || status === undefined) return null;
  if (typeof status.output !== "boolean") return null;
  return status.output;
}

// RLY0 is closed exactly when nothing holds it open. This script is the only
// writer in this configuration, so the decision is taken from the observed output
// rather than from an internal hold, and no call is made when it already matches.
function applyRelayPolicy() {
  let tab5 = tab5Intent();
  let holdOpen = lockValue !== 0 || tab5;
  let observed = relayOutput();
  if (holdOpen) {
    // Latch WHY the relay is being opened before the contactor can drop. The
    // falling SW edge arrives from the status handler after this call returns,
    // and Tab5 may have withdrawn its intent by then, so the reason has to
    // outlive the intent that caused it. pumpStopped() reads this latch.
    if (lockValue === 0 && tab5) relayOpenForTab5 = true;
    relayOpenByScript = true;
    if (observed === true) Shelly.call("Switch.Set", { id: 0, on: false });
  } else {
    relayOpenForTab5 = false;
    relayOpenByScript = false;
    if (observed === false) Shelly.call("Switch.Set", { id: 0, on: true });
  }
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
  applyRelayPolicy();  // act on the new lock now instead of waiting for the tick
}

function pumpStarted() {
  // While RLY0 is held open - by this script's lock or by Tab5's inhibition - the
  // contactor cannot be energized. Any edge seen in that state is not a pump
  // start, so it must not begin a run.
  if (lockState() !== 0 || tab5Intent()) return;
  runStartMs = Date.now();
}

function pumpStopped() {
  if (runStartMs === null) return;
  let ranMs = Date.now() - runStartMs;
  runStartMs = null;
  if (ranMs < 0) return;  // clock moved; discard rather than invent an infraction
  if (lockState() !== 0) return;
  let ranS = Math.floor(ranMs / 1000);
  if (relayOpenForTab5) {
    // This script opened RLY0 to apply Tab5's inhibition, so the pump was
    // commanded to stop. A commanded stop is not chatter and must not score a
    // strike; three of them would otherwise reach the permanent lockout that
    // only a person can clear. Genuine short cycles are unaffected: a stop that
    // happens while Tab5 merely intends an inhibit it has not yet applied still
    // finds this latch false and scores normally.
    print("[anti-chatter] stop applied Tab5 inhibition after " + ranS + "s; no strike");
    return;
  }
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

  // One level-based decision per tick covering both holds. Steady state issues
  // no relay call at all, whichever way the policy resolves.
  applyRelayPolicy();

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
if (!hasHandle(tab5IsLocked)) {
  print("[anti-chatter] WARNING: Tab5IsLocked handle unavailable. Local " +
        "short-cycle protection is active, but Tab5 inhibition cannot be applied " +
        "and a Tab5-commanded stop cannot be distinguished from a short cycle.");
}

// Volatile by design: a reboot is a sanctioned clear, so start from a known
// unlocked state with no run in progress. Tab5IsLocked is deliberately NOT written
// here: Tab5 owns it, and a script restart without a device reboot must not wipe an
// inhibition Tab5 still believes it holds. Its own default_value covers a real boot.
setLock(0);
setStrikes(0);
applyRelayPolicy();

let initial = Shelly.getComponentStatus("input:0");
if (initial !== null && initial !== undefined && initial.state === true) {
  // Already energized at start: treat it as a run beginning now rather than
  // guessing how long it has been running.
  runStartMs = Date.now();
}

Timer.set(1000, true, tick);
print("[anti-chatter] started; Tab5IsLocked=" + (hasHandle(tab5IsLocked) ? tab5Intent() : "unavailable") +
      "; MinRuntime=" + readNumber(minRuntime, 60, 1, 600) +
      "s InitLockTime=" + readNumber(initLockTime, 90, 1, 86400) +
      "s MaxLOcntr=" + readNumber(maxLockoutCount, 3, 1, 3) +
      " TimeToResetLOcntr=" + readNumber(lockoutResetTime, 3600, 60, 86400) + "s");
