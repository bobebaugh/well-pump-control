# Development workflow

## Git and deployment branches

- `main` is the stable future production branch.
- `pilot` is the active integration branch and Netlify branch-deploy source.
- Short feature branches merge into `pilot` when isolation or review is useful.
- Accepted pilot work later merges from `pilot` into `main`.

## Windows PC firmware path

GitHub stores and versions firmware source; the Windows development PC compiles and physically flashes the Tab5.

1. Clone this repository onto the Windows development PC.
2. Check out `pilot`.
3. Open `firmware/tab5` in the configured VS Code ESP-IDF environment.
4. Use ESP-IDF v5.4.2 with the ESP32-P4/Tab5 target.
5. Connect Tab5 to the PC by USB.
6. Build, flash, and monitor with the ESP-IDF extension or documented `idf.py` commands.
7. Commit only tested source and push it to the appropriate branch.

## Existing bench source

The existing M5Stack UserDemo remains an untouched vendor reference. The non-destructive diagnostic currently at `diagnostics/tab5_sd_ads1110` on the development PC is not yet in this repository. Import it deliberately after the repository is cloned, preserving:

- read-only SD behavior;
- external I2C 5 V state preservation and restoration;
- non-destructive I2C scanning and ADS1110 reads;
- established GPIO 53/54 and address 0x48 findings.

Do not copy vendor build output or local secrets into the repository.

## Netlify

Configure Netlify with:

- production branch: `main`;
- branch deploy: `pilot`;
- pilot Firebase and authentication secrets in the branch-deploy environment context.

Do not place secret values in `netlify.toml`, source files, examples, or screenshots.
