// @meta {"vc":{"isLocked":{"type":"number","config":{"name":"IsLocked","min":-1,"max":86400,"default_value":0,"persisted":false,"meta":{"ui":{"unit":"s","step":1}}}},"lockoutCount":{"type":"number","config":{"name":"loCntr","min":0,"max":3,"default_value":0,"persisted":false,"meta":{"ui":{"step":1}}}},"tab5IsLocked":{"type":"boolean","config":{"name":"Tab5IsLocked","default_value":false,"persisted":false}}}}

// User-adjustable settings. Edit these values at the beginning of the script in
// the Shelly script editor; they are deliberately not virtual components.
let MinRuntime = 60;
let InitLockTime = 90;
let MaxLOcntr = 3;
let TimeToResetLOcntr = 3600;
let InitDelay = 5;

// Shelly 1 anti-chatter / short-cycle protection.
//
// The @meta line above must stay on line 1. It declares the three interface
// components; with it anywhere else the handles come back undefined.
//
// AUTHORITY. This script is the sole writer of RLY0 and sits above Tab5. Tab5 reads
// IsLocked and loCntr and must never write, clear, or work around them; it publishes
// its own inhibition as the Tab5IsLocked boolean. This script initializes that
// value false, then reads Tab5's updates. Nothing here starts a pump: RLY0 is one
// series element in the automation-controlled G/B- loop, so the only thing this
// script can do is refuse to complete that loop. The pressure switch on the B+ side,
// the 3-second on-delay, the 6-minute max-runtime limit, and the HAND bypass all
// remain in front of it and are unaffected.
//
// STARTUP. The Shelly power-on default leaves RLY0 open. This script initializes
// Tab5IsLocked false and holds RLY0 open for InitDelay seconds. During that window
// Tab5 may reassert a hard lock. When the delay ends, normal relay processing begins.
//
// RELAY POLICY. After startup, RLY0 is closed exactly when IsLocked == 0 AND
// Tab5IsLocked == false, and open otherwise. The policy is applied against the
// observed output once a second, so steady state costs no Switch.Set call. A missing
// or unusable Tab5IsLocked handle removes Tab5's contribution only - it can never
// clear or override this script's own lock.
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
// The five settings above are script constants and therefore survive a reboot.

let isLocked = Script.getVcHandle("isLocked");
let lockoutCount = Script.getVcHandle("lockoutCount");
let tab5IsLocked = Script.getVcHandle("tab5IsLocked");
if (tab5IsLocked !== null && tab5IsLocked !== undefined &&
    typeof tab5IsLocked.setValue === "function") {
  tab5IsLocked.setValue(false);
}

let PERMANENT = -1;
let lockValue = 0;           // authoritative lock state; mirrored to IsLocked
let strikeValue = 0;         // authoritative strike count; mirrored to loCntr
let relayOpenByScript = false;  // true while this script is holding RLY0 open
let relayOpenForTab5 = false;  // true when that hold is applying Tab5's inhibition
let observedInputLevel = null;  // last input:0 level acted on; null until seeded
let runStartS = null;        // uptimeS at the rising SW edge, null when not running
let lastInfractionS = null;  // drives the loCntr decay window
let initSecondsRemaining = 0;
let initializationComplete = false;
// Monotonic seconds counted by the tick itself. Date.now() is wall clock, and the
// device steps it when SNTP lands shortly after boot - exactly when this script is
// starting. A step in either direction corrupted a run measurement and could
// silently forgive accumulated strikes. One-second resolution is all MinRuntime
// and TimeToResetLOcntr ever needed.
let uptimeS = 0;

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

// The virtual components used to enforce these ranges in the Shelly UI. Plain
// constants do not, so a typo could silently disable protection - MaxLOcntr above
// 3 never reaches the strikeout, MinRuntime of 0 detects nothing. Clamp once.
function clampSetting(value, low, high, fallback) {
  let checked = clamp(value, low, high);
  return checked === null ? fallback : checked;
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

// The input level, read the same tri-state way as the relay output: null means
// it was not readable this pass, which must never be mistaken for an edge.
function inputLevel() {
  let status = Shelly.getComponentStatus("input:0");
  if (status === null || status === undefined) return null;
  if (typeof status.state !== "boolean") return null;
  return status.state;
}

// The ONLY path to pumpStarted/pumpStopped. Both the status handler and the tick
// feed it, and it acts only on a change from the level last acted on, so an edge
// counts exactly once no matter how many sources report it.
//
// Why two sources. The status handler is the fast path and the tick is the
// backstop. A level this script never receives a notification for is otherwise
// invisible to it forever: the run is never started, the falling edge finds
// runStartS null and returns in silence, and loCntr sits at 0 through any number
// of genuine short cycles. That is not hypothetical - it is the reported symptom
// this backstop was added for. The handler's event shape is an assumption about
// the firmware; a polled level is not.
function observeInputLevel(level) {
  if (typeof level !== "boolean") return;   // unreadable, or no state field
  if (observedInputLevel === level) return;
  observedInputLevel = level;
  // Before normal processing begins the level is tracked but never acted on, so
  // a pump already running at startup does not register as a fresh start.
  if (!initializationComplete) return;
  if (level === true) pumpStarted();
  else pumpStopped();
}

function holdRelayOpenDuringInitialization() {
  let observed = relayOutput();
  if (observed === true) Shelly.call("Switch.Set", { id: 0, on: false });
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
  lastInfractionS = uptimeS;
  if (count >= MaxLOcntr) {
    setLock(PERMANENT);
    print("[anti-chatter] STRIKEOUT: loCntr=" + count + "; RLY0 open until reboot");
  } else {
    setLock(InitLockTime);
    print("[anti-chatter] strike " + count + "; RLY0 open for " + InitLockTime + "s");
  }
  applyRelayPolicy();  // act on the new lock now instead of waiting for the tick
}

function pumpStarted() {
  // While RLY0 is held open - by this script's lock or by Tab5's inhibition - the
  // contactor cannot be energized. Any edge seen in that state is not a pump
  // start, so it must not begin a run.
  if (lockState() !== 0 || tab5Intent()) return;
  runStartS = uptimeS;
}

function pumpStopped() {
  if (runStartS === null) return;
  let ranS = uptimeS - runStartS;
  runStartS = null;
  if (lockState() !== 0) return;
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
  if (ranS < MinRuntime) {
    print("[anti-chatter] short cycle: " + ranS + "s");
    recordInfraction();
  }
}

function tick() {
  uptimeS += 1;

  if (!initializationComplete) {
    holdRelayOpenDuringInitialization();
    // Seed, never act: this runs on the completing tick too, so the poll below
    // sees no change and cannot manufacture an edge out of the startup level.
    observedInputLevel = inputLevel();
    initSecondsRemaining -= 1;
    if (initSecondsRemaining > 0) return;
    initializationComplete = true;
    print("[anti-chatter] initialization delay complete; normal relay processing started");
  }

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

  if (lockValue === 0 && strikes() > 0 && lastInfractionS !== null) {
    if (uptimeS - lastInfractionS >= TimeToResetLOcntr) {
      setStrikes(0);
      lastInfractionS = null;
      print("[anti-chatter] clean period elapsed; loCntr reset");
    }
  }

  // The backstop, last. A notification that already arrived moved
  // observedInputLevel, so this is a no-op in the ordinary case and costs one
  // local status read. Running it after the lock has been serviced keeps a
  // poll-detected infraction identical to a handler-detected one: the lock it
  // sets is not then decremented by the same tick that set it. Relay response is
  // unaffected either way, because recordInfraction applies the policy itself.
  observeInputLevel(inputLevel());
}

// The fast path for an input:0 edge. Not the only path: tick() polls the level
// as a backstop, and both funnel through observeInputLevel so an edge reported
// twice is still counted once. This handler exists to catch a run shorter than
// the one-second tick, which the poll alone would miss.
//
// The event shape below is an assumption about the firmware and has never been
// confirmed on this device. That is precisely why it is no longer load-bearing.
Shelly.addStatusHandler(function (event) {
  if (event === null || event === undefined) return;
  if (event.component !== "input:0") return;
  // A falsy delta covers both null and undefined. An exception thrown here stops
  // the script, which leaves RLY0 frozen wherever it was with nothing logged.
  if (!event.delta || typeof event.delta.state !== "boolean") return;
  observeInputLevel(event.delta.state);
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

// Start from an open relay and a clean local state. Tab5 has InitDelay seconds to
// replace the false seed with a true hard lock before normal processing may close
// RLY0. After initialization this script only reads Tab5IsLocked.
MinRuntime = clampSetting(MinRuntime, 1, 600, 60);
InitLockTime = clampSetting(InitLockTime, 1, 86400, 90);
MaxLOcntr = clampSetting(MaxLOcntr, 1, 3, 3);
TimeToResetLOcntr = clampSetting(TimeToResetLOcntr, 60, 86400, 3600);
InitDelay = clampSetting(InitDelay, 1, 60, 5);
initSecondsRemaining = InitDelay;

setLock(0);
setStrikes(0);
observedInputLevel = inputLevel();
holdRelayOpenDuringInitialization();

Timer.set(1000, true, tick);
print("[anti-chatter] started open; InitDelay=" + InitDelay +
      "s Tab5IsLocked=false MinRuntime=" + MinRuntime +
      "s InitLockTime=" + InitLockTime +
      "s MaxLOcntr=" + MaxLOcntr +
      " TimeToResetLOcntr=" + TimeToResetLOcntr + "s");
