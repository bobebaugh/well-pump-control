# Well Pump Pressure Calibration and Fill Qualification

**Status:** Retained hardware qualification evidence; the fitted conversion is implemented and pressure is commissioned in M6.42
**Qualification date:** 2026-08-26  
**Repository:** `bobebaugh/well-pump-control`  
**Branch:** `Tab5`  
**Qualified utility release:** `pilot.py` M6.15  
**Git commit:** `ac601488704aa1d4d5b8a7f29e08a4edaab15726`

## Purpose and authority boundary

This record documents the first hardware qualification of the Tab5 pressure-sensor calibration and uninterrupted-fill utilities. The utilities are manually selected during a short boot pause and run instead of the normal observational application. They may write deliberately captured test evidence to Tab5 flash for export.

The utilities and normal application remain observational. They do not evaluate production rules, start the pump, or grant Tab5 pump-start authority. The normal application, CPU B cloud program, Netlify functions, and production `main` branch were not changed as part of this qualification.

## Hardware and ADC configuration

- Tab5 with M5Stack Unit ADC v1.1 on Port A, SoftI2C address `0x48`, GPIO 53/54.
- Pressure transducer: nominal 0.5â€“4.5 V output for 0â€“100 PSI.
- ADS1110 mode: continuous.
- Sample rate: 15 SPS, 16-bit conversion.
- PGA: gain 2.
- M5 Unit ADC v1.1 terminal divider: nominal 6:1.
- ADC-pin full scale at gain 2: Â±1.024 V.
- Terminal full scale at gain 2: Â±6.144 V.
- Nominal terminal resolution: 187.5 ÂµV/count.
- Nominal sensor slope: 40 mV/PSI, or 213.333 counts/PSI.

The implementation reads the ADS1110 conversion and configuration bytes directly. For each fresh sample it discards the conversion present at entry, waits for a later reply with `ST/DRDY = 0`, decodes the signed raw count, and uses a bounded timeout with one ADC reinitialization retry.

## Boot-selected utility framework

The release exercised the intended alternate-boot framework for the first time:

1. Tab5 presents a short boot-selection pause.
2. If Pressure Qualification is selected, the utility menu runs instead of normal processing.
3. The menu offers Gauge Calibration, Fill Run, and Restart Normal.
4. Leaving the selection untouched times out into the regular application.

The boot selection, touch interface, utility execution, return path, and restart into normal processing were physically exercised successfully.

## Gauge Calibration program

The Gauge Calibration screen:

- Starts at 60 PSI in falling mode.
- Acquires five demonstrably fresh raw ADC conversions in each one-second cycle.
- Displays the previously completed batch at the start of the next anchored cycle.
- Displays S1â€“S5, arithmetic average, nominal sensor PSI, selected flow window, and signed derived GPM.
- Allows gauge PSI adjustment, direction metadata selection, and a 3â€“30 second flow window.
- Writes nothing during idle display sampling.
- Opens a new numbered `pressure-cal-NNN.csv` file only on the first explicit capture.
- Appends and flushes one row for every press of **CAPTURE DISPLAYED BATCH**.
- Saves exactly the batch visible when Capture is pressed.
- Automatically changes the gauge target by one PSI in the selected direction after a successful capture.

Multiple readings at the same nominal gauge pressure append separate rows; they do not overwrite. The operator must restore the displayed target with the PSI adjustment button before a repeated same-pressure capture.

## Uninterrupted Fill program

The Fill Run utility:

- Acquires the same five-fresh-conversion raw batch at approximately one-second intervals.
- Records S1â€“S5, arithmetic average, nominal PSI, actual measurement start/end/midpoint ticks, and elapsed time.
- Polls Shelly EM after the pressure batch and records power, voltage, availability, validity, and derived pump-running state.
- Appends and flushes every completed observation to a numbered `pressure-fill-NNN.csv` file.
- Uses actual timestamps as the authority when flash, display, garbage collection, I2C, or Wi-Fi work delays a cycle.
- Shows raw-count average and nominal sensor PSI on the Tab5 display.

## Electrical-zero qualification

The ADC input was deliberately shorted to ADC ground for 62 observations:

- 310 individual conversions were recorded.
- 309 conversions read 34 counts.
- One conversion read 35 counts.
- Overall mean: 34.003 counts.
- Population standard deviation: approximately 0.057 count.
- Terminal-equivalent offset: approximately 6.38 mV.
- Pressure-equivalent offset at the nominal sensor slope: approximately 0.16 PSI.

This grounded result is the ADC/module electrical offset. It must not be confused with the fitted sensor-system count intercept at zero gauge pressure. No manual subtraction of 34 counts is planned; end-to-end pressure calibration absorbs ADC, divider, sensor, wiring, and reference effects together.

The zero test produced 62 complete CSV rows over 61.717 seconds. Sixty of 61 intervals were 952â€“1,061 ms and averaged 999.9 ms. One interval was 1.572 seconds. The delay was recorded correctly by the actual timestamps.

## Pressure calibration dataset and fit

The best-effort analog-gauge sweep contains nominal one-PSI observations from 60 down to 40 PSI, including two 40 PSI captures. The gauge has 10-PSI numbered marks with small one-PSI ticks; manual reading uncertainty is approximately Â±0.3â€“0.5 PSI. The ADC is substantially more repeatable than the reference gauge:

- Within-batch spread during calibration: 1â€“5 counts.
- Equivalent within-batch pressure spread: no more than approximately 0.023 PSI.
- Reference-gauge readability, not ADC noise, limits absolute calibration accuracy.

The final row labeled 39 PSI is invalid as a calibration observation. It was captured only 1.023 seconds after the preceding 40 PSI observation with essentially identical raw counts. It represents the screen's automatic decrement without a corresponding physical one-PSI pressure change and must be excluded.

Because the goal is to predict reference pressure from precise raw counts, the preferred fit regresses recorded gauge PSI on raw count after excluding the invalid final row:

```text
PSI = (raw_count - 3732.02) / 211.492
```

Equivalent form:

```text
PSI = -17.64619 + 0.004728319 * raw_count
```

Fit evidence:

- Usable captured rows: 22.
- RÂ²: approximately 0.9987.
- RMS residual: approximately 0.23 PSI.
- Maximum residual: approximately 0.57 PSI.
- Validated range: approximately 40â€“61 PSI.

An alternative raw-on-pressure fit that included all 23 rows produced `PSI = (raw - 3812.27) / 209.97`. That result is not selected because it includes the invalid final 39-PSI row and treats gauge pressure as the error-free independent variable. Excluding the invalid row makes the competing regression directions nearly identical over the operating range.

The fitted slope is an end-to-end pressure-system result. It does not independently measure the ADC board's full-scale voltage because it combines gauge, transducer, divider, ADC, capture-timing, and hydraulic effects. The nominal 6.144 V terminal range remains valid ADS1110 gain-2 plus M5 6:1-divider hardware math.

The fitted conversion is not directly validated at 0 or 100 PSI. Readings near 66â€“70 PSI are modest extrapolations until physical evidence is obtained there.

## Captured fill result

The successful fill trace contained 113 complete observations over 114.037 seconds:

- Initial calibrated pressure: approximately 39.7 PSI.
- Pump detected running at observation 9, elapsed 8.160 seconds.
- Pump detected stopped at observation 102, elapsed 103.041 seconds.
- Pump-running observations: 93.
- Average running power: approximately 2,920 W.
- Observed running-power range: approximately 2,839â€“2,946 W.
- Average stopped power: approximately 12.3 W.
- Peak calibrated pressure: approximately 61.27 PSI.
- Final settled pressure: approximately 60.13 PSI.
- Calibrated 40â€“60 PSI rise time: approximately 89.5 seconds.

If house demand was isolated, the manufacturer's 20.5-gallon 40â€“60 PSI drawdown implies an average net tank-fill rate of approximately:

```text
20.5 gallons / 89.5 seconds * 60 = 13.7 GPM
```

The working absolute-pressure tank model uses:

- Tank effective volume: 79.3 gallons.
- Precharge: 38 PSIG.
- Site atmospheric pressure: 13.1 PSI.

That model predicts approximately 20.88 gallons between 40 and 60 PSI, only about 1.9% above the manufacturer's 20.5-gallon figure. This is a useful cross-check, not proof of exact tank volume.

A preliminary ten-second rolling calculation suggests pump delivery declines from roughly 15 GPM at lower tank pressure toward roughly 11 GPM near cut-out, with a central result around 13â€“14 GPM. That trend is physically plausible because pump delivery decreases as discharge head rises. It remains an estimator, not a direct flow-meter measurement.

The three-second flow values stored with manually stopped gauge captures include transient spikes and are not reliable pump-flow evidence. Manual valve movement, one-cycle displayed-batch age, and hydraulic settling dominate such a short window.

## Timing evidence

Of 112 fill-run intervals:

- 110 were 945â€“1,042 ms and averaged 999.8 ms.
- Two were approximately 1.95 and 1.97 seconds.
- Sequence numbers remained continuous.
- No completed observation row was lost.

The longer intervals occurred after a completed Shelly poll and before the next ADC batch. The uninstrumented portion contains CSV formatting/write/flush, display updates, and possible MicroPython garbage collection. Flash latency or garbage collection is the most likely source, but the present evidence cannot distinguish them. Actual timestamps prevent the delays from being misrepresented as one-second intervals.

## Conclusions and next decisions

1. The sensor and ADC are feasible and substantially more repeatable than the analog reference gauge.
2. The alternate-boot utility framework, touch controls, raw acquisition, flash export, and restart path passed physical testing.
3. The captured raw evidence supports an end-to-end linear pressure calibration over approximately 40â€“61 PSI.
4. The preferred current conversion is `PSI = (raw - 3732.02) / 211.492`.
5. The normal application uses the fitted formula; M6.42 enables commissioned pressure. The raw evidence below is retained independently of release status.
6. A 10-second regression window is a better default for operational flow estimation than three seconds; the adjustment controls should remain.
7. Raw count, calibrated pressure, actual measurement timestamps, regression slope, estimated flow, and pump power should remain separately observable.
8. Pressure and flow remain estimators. Manufacturer drawdown and repeated complete pump cycles should be used as ongoing self-check evidence.
9. No utility or normal-application change may grant Tab5 pump-start authority.

## Source evidence retained by operator

- `ADC Shorted to Zero Volts.csv`
- `Good Pressure Calibration.csv`
- `Good Captured Fill.csv`
- Photographs of the running Gauge Calibration screen
- Repository tests in `tests/test_tab5_pressure_flow.py`

The raw CSV files remain the authoritative measurement evidence. This Markdown record summarizes the qualified behavior and analysis without replacing those files.
