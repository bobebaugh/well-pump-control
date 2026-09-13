# Web HMI

The remote HMI will present the same operational meaning as the Tab5 display while adapting its layout for a browser.

The pilot will show:

- pump RUNNING/STOPPED state derived from actual motor power;
- live power, voltage, power factor, and current-cycle runtime;
- a short power trend;
- Shelly EM, Tab5, and cloud communication health;
- recent events and completed-cycle summaries;
- future pressure areas explicitly marked unavailable;
- three authenticated owner controls: User Monitor, actual Tab5 restart, and
  supported Shelly 1 restart, with explicit delivery/completion evidence.

It does not expose ordinary pump demand, Hand sensing, Monitor OFF, Clear Events,
or System Monitor actuation. User Monitor remains a deliberate temporary Tab5
protection bypass and never overrides mechanical or Shelly-local protection.
