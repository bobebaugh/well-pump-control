# Repository guidance

## Safety and authority

- The current pilot is observational only.
- Never add pump start, stop, inhibit, relay, or control authority unless the requested phase explicitly includes a reviewed control change.
- Tab5 must never manufacture ordinary pump demand.
- Netlify and Firestore must never be placed in an immediate protective path.
- Do not weaken existing hardwired protection.

## Data contracts

- Update versioned files under `contracts/` before changing exchanged field meaning.
- Preserve units, validity, observation time, source, and staleness semantics.
- Do not label a derived value as directly measured.
- Treat unavailable future sensors and controls as unavailable; never fabricate values for the HMI.

## Security

- Never commit secrets, credentials, tokens, private keys, Wi-Fi information, or production configuration values.
- Tab5 sends authenticated HTTPS requests to Netlify and never holds Firestore administrative credentials.
