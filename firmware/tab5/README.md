# Tab5 firmware

This directory will contain the owned ESP-IDF application for the M5Stack Tab5.

Initial responsibilities:

1. connect to the configured local network;
2. poll the Gen-1 Shelly EM local endpoint;
3. validate and normalize readings;
4. maintain current observational state and completed-cycle statistics;
5. render the local HMI through one LVGL owner;
6. report through authenticated HTTPS to Netlify;
7. expose stale and fault state when dependencies fail.

The firmware must remain observational during the pilot.

The existing M5Stack UserDemo stays untouched as a vendor reference. Reusable hardware knowledge from `diagnostics/tab5_sd_ads1110` will be imported from the Windows development PC after its source is available.
