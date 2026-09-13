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

## Relationship to the running application

The record's conclusion 5 says the normal application had not yet adopted the
fitted formula. That was true at M6.15 on the `Tab5` branch and is now out of
date: `tab5/pilot.py` carries `PRESSURE_CALIBRATION_COUNT_INTERCEPT = 3732.02`
and `PRESSURE_CALIBRATION_COUNTS_PER_PSI = 211.492`, and `build_observation`
computes `pressure_psi` from them every cycle.

What still gates operational use is `PRESSURE_SENSOR_COMMISSIONED = False`, which
drives `pressure_valid` in the observation record and the `NOT COMMISSIONED` state
on the HMI. Pressure and flow remain estimators either way.

## Not included

`ADC Shorted to Zero Volts.csv`, the 62-observation electrical-zero test described
in the record, is retained by the operator and has not been added here.
