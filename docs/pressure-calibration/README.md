# Pressure calibration evidence

Raw measurement evidence from the 2026-08-26 hardware qualification of the Tab5
pressure-sensor calibration and uninterrupted-fill utilities, moved here from
operator local storage so it lives with the source.

| File | What it is |
| --- | --- |
| `pressure-calibration-and-fill-qualification.md` | The qualification record: hardware configuration, method, fit, and conclusions. |
| `Good_Pressure_Calibration.csv` | 23 gauge-sweep captures, 60 → 39 PSI falling. The calibration dataset. |
| `Good_Captured_Fill.csv` | 113 observations over 114.037 s of one uninterrupted 40 → 60 PSI fill, with Shelly EM power. |

The CSV files are the authoritative measurement evidence. The Markdown record
summarizes and analyses them; it does not replace them.

## Reading the CSVs

The `nominal_psi` column in both files is the **uncalibrated nominal** conversion
(40 mV/PSI at the nominal 187.5 µV/count terminal resolution). It is not the
qualified pressure. Apply the fitted conversion to `average_raw_count`:

```text
PSI = (raw_count - 3732.02) / 211.492
```

Validated over approximately 40–61 PSI. R² ≈ 0.9987, RMS residual ≈ 0.23 PSI.

Two known data caveats, both explained in the record:

- The final `Good_Pressure_Calibration.csv` row labelled 39 PSI is **invalid** as a
  calibration observation. It was captured 1.023 s after the preceding 40 PSI row
  with essentially identical counts — the screen's automatic decrement without a
  physical pressure change. It is excluded from the fit and retained only so the
  captured evidence stays complete.
- The `estimated_flow_gpm` values in the calibration file use a 3-second window and
  include transient spikes from manual valve movement. They are not reliable
  pump-flow evidence. Ten seconds is the better operational default.

## Current application

The qualified formula is implemented in main.py and used by pilot.py. M6.42 sets
PRESSURE_SENSOR_COMMISSIONED true. The separately published package expression
must match that fit. Pressure/flow remain estimates; see FUTURE before recalibration.
At the two-second beta cadence, the package's eight-sample flow window needs more
than ten seconds. The measurement CSVs and their caveats above remain unchanged.

## Not included

The electrical-zero capture is retained separately by the owner.
