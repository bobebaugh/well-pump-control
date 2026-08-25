# M6.10 installed Shelly 1 telemetry

The installed Gen-1 Shelly 1 is temporarily addressed at `192.168.50.201`. During commissioning, RLY0 is not connected to the pump circuit. SW0 is expected to be ON while the pump is running and OFF while it is stopped.

CPU A reads `/status` once per sample cycle and strictly extracts `inputs[0].input` and `relays[0].ison`. The complete observation carries `shelly1_sw0`, `shelly1_rly0`, availability, age, and failure count. A boolean SW0 or RLY0 edge is material. A missed poll produces unknown state rather than a false edge, and availability changes use the existing three-sample confirmation.

CPU B already transports the complete observation unchanged, so no CPU B network or credential change is required. The matching nondeploying cloud/web candidate exposes the stored fields from `current-power`, shows them on the monitoring page, and flags a fresh SW0/pump-state mismatch. It does not provide a relay command.
