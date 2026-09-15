# Release: 2026-09-15 M6.41 - pressure qualification, extracted from pilot.py.
# MANUALLY SELECTED UTILITY. Not part of the 24x7 application.
#
# Imported by main.py only when PRESSURE QUALIFICATION is chosen at the startup
# selector, and it never returns: every path ends in a reboot. That is what lets
# it be simple - there is no handing control back to normal monitoring, and CPU B
# is never started, so nothing publishes or polls while a capture is running.
#
# IT CANNOT IMPORT pilot. Importing pilot IS starting the 24x7 application. What
# both need - the ADS1110 stack and the qualified sensor fit - lives in main.py,
# which owns board initialisation, so exactly one converter configuration and one
# calibration exist on this device.
#
# THIS IS THE ONLY CODE HERE THAT WRITES FLASH. _open_calibration_log and
# _write_calibration_capture produce CSVs. Keeping them out of pilot.py is what
# makes "the normal 24x7 application adds no routine flash logging" a structural
# property rather than a convention.

import M5
import os
import time
import requests
import __main__
from machine import reset

# The converter and the fit, from the launcher. One copy of each on the device.
read_ads1110_fresh_raw_count = __main__.read_ads1110_fresh_raw_count
calibrated_psi_from_raw_count = __main__.calibrated_psi_from_raw_count
PRESSURE_CALIBRATION_COUNTS_PER_PSI = __main__.PRESSURE_CALIBRATION_COUNTS_PER_PSI
PRESSURE_SENSOR_SPAN_PSI = __main__.PRESSURE_SENSOR_SPAN_PSI
SHELLY_EM_URL = __main__.SHELLY_EM_URL

WHITE = 0xFFFFFF
CYAN = 0x9EB4D8
GREEN = 0x16835d
BLUE = 0x2457c5
RED = 0xFF4444
YELLOW = 0xE8B93E
BG = 0x07152e

# This utility's own capture cadence. It borrowed pilot.py's SAMPLE_PERIOD_MS
# until M6.41, which meant the M6.40 move to a 2000ms observation cycle silently
# halved the calibration sample rate. The captures behind the shipped fit were
# taken at 1 Hz; this keeps them comparable, and the two cadences are now free to
# differ because they always measured different things.
QUAL_SAMPLE_PERIOD_MS = 1000


def log(msg):
    print('[well-qual] {}'.format(msg))


def draw_label(text, x, y, font, color, bg=BG):
    M5.Lcd.setFont(font)
    M5.Lcd.setTextColor(color, bg)
    M5.Lcd.drawString(text, x, y)


def read_shelly():
    """One EM power reading, for telling a running pump from a stopped one.

    Deliberately not pilot.py's read_shelly: that one carries the 24x7 loop's
    failure classification and diagnostic counters, none of which a hand-driven
    utility needs. A failed read here is simply no reading.
    """
    try:
        reply = requests.get(SHELLY_EM_URL, timeout=1)
        if getattr(reply, 'status_code', None) != 200:
            return None
        data = reply.json()
        reply.close()
    except Exception:
        return None
    if not isinstance(data, dict) or data.get('is_valid') is not True:
        return None
    power = data.get('power')
    if isinstance(power, bool) or not isinstance(power, (int, float)):
        return None
    return {'power': power, 'is_valid': True}


QUAL_CAPTURE_SAMPLES = 5
QUAL_PUMP_START_W = 1000.0
QUAL_PUMP_STOP_W = 100.0
QUAL_CALIBRATION_START_PSI = 60.0
QUAL_CALIBRATION_START_DIRECTION = 'falling'
QUAL_FLOW_WINDOW_DEFAULT_SECONDS = 10
QUAL_FLOW_WINDOW_MIN_SECONDS = 3
QUAL_FLOW_WINDOW_MAX_SECONDS = 30
QUAL_FLOW_MIN_SPAN_MS = 900
QUAL_FLOW_WINDOW_TOLERANCE_MS = 350
PRESSURE_PSI_PER_COUNT = 1.0 / PRESSURE_CALIBRATION_COUNTS_PER_PSI
TANK_EFFECTIVE_VOLUME_GAL = 79.3
TANK_PRECHARGE_PSIG = 38.0
SITE_ATMOSPHERE_PSI = 13.1




def qualification_pump_running(power_w, previous,
                               start_w=QUAL_PUMP_START_W,
                               stop_w=QUAL_PUMP_STOP_W):
    """Apply the pilot's cloud thresholds locally, retaining hysteresis."""
    if isinstance(power_w, bool) or not isinstance(power_w, (int, float)):
        return previous
    if previous is True:
        return power_w > stop_w
    return power_w >= start_w


def qualification_midpoint_ticks(start_ticks_ms, end_ticks_ms):
    """Return the wrap-safe midpoint of a completed local measurement."""
    return time.ticks_add(
        start_ticks_ms,
        time.ticks_diff(end_ticks_ms, start_ticks_ms) // 2)


def average_raw_adc_counts(samples):
    """Return the arithmetic mean only for a complete signed ADC batch."""
    if not isinstance(samples, list) or len(samples) != QUAL_CAPTURE_SAMPLES:
        return None
    for value in samples:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
    return sum(samples) / QUAL_CAPTURE_SAMPLES




def raw_count_regression_slope(history, reference_ticks_ms, window_seconds,
                               tolerance_ms=0):
    """Least-squares counts/ms over a real tick horizon, handling tick wrap."""
    if (isinstance(window_seconds, bool) or
            not isinstance(window_seconds, (int, float)) or window_seconds <= 0):
        return None
    horizon_ms = int(window_seconds * 1000) + max(0, int(tolerance_ms))
    points = []
    for item in history:
        if not isinstance(item, dict):
            continue
        raw_count = item.get('average_raw_count')
        midpoint = item.get('midpoint_ticks_ms')
        if (isinstance(raw_count, bool) or not isinstance(raw_count, (int, float)) or
                isinstance(midpoint, bool) or not isinstance(midpoint, int)):
            continue
        age_ms = time.ticks_diff(reference_ticks_ms, midpoint)
        if 0 <= age_ms <= horizon_ms:
            points.append((age_ms, raw_count))
    if len(points) < 2:
        return None
    # x increases forward in time, while age decreases.  This avoids trusting
    # a uniform one-second cadence and leaves tick arithmetic wrap-safe.
    points = [(-age_ms, raw_count) for age_ms, raw_count in points]
    mean_x = sum(point[0] for point in points) / len(points)
    mean_y = sum(point[1] for point in points) / len(points)
    denominator = sum((point[0] - mean_x) ** 2 for point in points)
    if denominator <= 0:
        return None
    return (sum((point[0] - mean_x) * (point[1] - mean_y)
                for point in points) / denominator)


def pressure_flow_evidence(history, current_batch, window_seconds):
    """Return distinct calibrated slope and derived flow evidence."""
    if not isinstance(current_batch, dict):
        return None
    current_count = current_batch.get('average_raw_count')
    midpoint = current_batch.get('midpoint_ticks_ms')
    if (isinstance(current_count, bool) or not isinstance(current_count, (int, float)) or
            isinstance(midpoint, bool) or not isinstance(midpoint, int)):
        return None
    pressure_psig = calibrated_psi_from_raw_count(current_count)
    if pressure_psig is None or pressure_psig < 0 or pressure_psig > PRESSURE_SENSOR_SPAN_PSI:
        return None
    horizon_ms = int(window_seconds * 1000) + QUAL_FLOW_WINDOW_TOLERANCE_MS
    valid_points = []
    for item in history:
        if (isinstance(item, dict) and
                isinstance(item.get('midpoint_ticks_ms'), int) and
                isinstance(item.get('average_raw_count'), (int, float)) and
                not isinstance(item.get('average_raw_count'), bool)):
            age_ms = time.ticks_diff(midpoint, item['midpoint_ticks_ms'])
            if 0 <= age_ms <= horizon_ms:
                history_pressure = calibrated_psi_from_raw_count(
                    item['average_raw_count'])
                if (history_pressure is not None and 0 <= history_pressure <=
                        PRESSURE_SENSOR_SPAN_PSI):
                    valid_points.append(item)
    if len(valid_points) < 3:
        return None
    oldest_age_ms = max(time.ticks_diff(midpoint, item['midpoint_ticks_ms'])
                        for item in valid_points)
    required_span_ms = max(
        QUAL_FLOW_MIN_SPAN_MS,
        int(window_seconds * 1000) - QUAL_FLOW_WINDOW_TOLERANCE_MS)
    if oldest_age_ms < required_span_ms:
        return None
    slope_counts_per_ms = raw_count_regression_slope(
        valid_points, midpoint, window_seconds, QUAL_FLOW_WINDOW_TOLERANCE_MS)
    if slope_counts_per_ms is None:
        return None
    pressure_slope_psi_per_min = (slope_counts_per_ms * PRESSURE_PSI_PER_COUNT *
                                  60000.0)
    dvol_dpressure = (TANK_EFFECTIVE_VOLUME_GAL *
                      (TANK_PRECHARGE_PSIG + SITE_ATMOSPHERE_PSI) /
                      ((pressure_psig + SITE_ATMOSPHERE_PSI) ** 2))
    return {
        'pressure_slope_psi_per_min': pressure_slope_psi_per_min,
        'estimated_flow_gpm': dvol_dpressure * pressure_slope_psi_per_min,
    }




def qualification_filename(prefix):
    """Choose a short collision-free root filename without relying on UTC."""
    existing = set(os.listdir())
    for number in range(1, 1000):
        name = '{}-{:03d}.csv'.format(prefix, number)
        if name not in existing:
            return name
    raise OSError('qualification filename range exhausted')


def _qual_button(x, y, w, h, text, color=BLUE, font=None):
    M5.Lcd.fillRoundRect(x, y, w, h, 16, color)
    M5.Lcd.setFont(font or M5.Lcd.FONTS.Montserrat24)
    M5.Lcd.setTextColor(WHITE, color)
    M5.Lcd.drawString(text, x + 24, y + (h // 2) - 14)


def _qual_title(title, subtitle=None):
    M5.Lcd.fillScreen(BG)
    draw_label(title, 45, 30, M5.Lcd.FONTS.DejaVu40, WHITE)
    if subtitle:
        draw_label(subtitle, 48, 90, M5.Lcd.FONTS.Montserrat18, CYAN)


def _qual_tap(was_down):
    """Return one landscape touch-down edge and the current down state."""
    M5.update()
    try:
        down = M5.Touch.getCount() > 0
        if not down:
            return None, False
        if was_down:
            return None, True
        x = M5.Touch.getX()
        y = M5.Touch.getY()
        if x is None or y is None or x < 0 or y < 0:
            return None, True
        return (x, y), True
    except Exception:
        return None, False


def _qual_wait_release():
    while True:
        M5.update()
        try:
            if M5.Touch.getCount() <= 0:
                return
        except Exception:
            return
        time.sleep_ms(30)


def _in_button(point, x, y, w, h):
    return (point is not None and x <= point[0] <= x + w and
            y <= point[1] <= y + h)




def _qual_service_adc_wait():
    """Keep the HMI alive while the bounded fresh-conversion wait polls ST/DRDY."""
    try:
        M5.update()
    except Exception:
        pass


def _acquire_calibration_batch():
    """Acquire exactly five fresh raw counts and timestamp the real interval."""
    started_ms = time.ticks_ms()
    samples = []
    for unused in range(QUAL_CAPTURE_SAMPLES):
        raw_count = read_ads1110_fresh_raw_count(_qual_service_adc_wait)
        if raw_count is None:
            samples.append(None)
        else:
            samples.append(raw_count)
    ended_ms = time.ticks_ms()
    return {
        'raw_samples': samples,
        'average_raw_count': average_raw_adc_counts(samples),
        'start_ticks_ms': started_ms,
        'end_ticks_ms': ended_ms,
        'midpoint_ticks_ms': qualification_midpoint_ticks(started_ms, ended_ms),
    }


def _calibration_batch_text(batch):
    if not isinstance(batch, dict):
        return ['S1: --', 'S2: --', 'S3: --', 'S4: --', 'S5: --', 'AVG: --']
    samples = batch.get('raw_samples') or []
    fields = []
    for index in range(QUAL_CAPTURE_SAMPLES):
        value = samples[index] if index < len(samples) else None
        fields.append('S{}: {}'.format(index + 1, '--' if value is None else value))
    average = batch.get('average_raw_count')
    fields.append('AVG: {}'.format('--' if average is None else '{:.1f}'.format(average)))
    return fields


def _open_calibration_log(filename):
    """Open the capture-only CSV lazily: idle screen updates never touch flash."""
    handle = open(filename, 'w')
    handle.write('record_type,capture_id,direction,gauge_psi,'
                 's1_raw_count,s2_raw_count,s3_raw_count,s4_raw_count,s5_raw_count,'
                 'average_raw_count,measurement_start_ticks_ms,'
                 'measurement_end_ticks_ms,measurement_midpoint_ticks_ms,'
                 'calibrated_psi,flow_window_seconds,'
                 'pressure_slope_psi_per_min,estimated_flow_gpm\n')
    handle.flush()
    return handle


def _write_calibration_capture(handle, capture_id, batch, direction, gauge_psi,
                               flow_window_seconds, flow_evidence):
    """Persist exactly the batch currently displayed when Capture was tapped."""
    if handle is None or not isinstance(batch, dict):
        return False
    samples = batch.get('raw_samples') or []
    if len(samples) != QUAL_CAPTURE_SAMPLES:
        return False
    average = batch.get('average_raw_count')
    calibrated_psi = calibrated_psi_from_raw_count(average)
    slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                         if isinstance(flow_evidence, dict) else None)
    flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                if isinstance(flow_evidence, dict) else None)
    fields = ['capture', capture_id, direction, '{:.1f}'.format(gauge_psi)]
    fields.extend('' if value is None else value for value in samples)
    fields.extend([
        '' if average is None else '{:.3f}'.format(average),
        batch.get('start_ticks_ms', ''), batch.get('end_ticks_ms', ''),
        batch.get('midpoint_ticks_ms', ''),
        '' if calibrated_psi is None else '{:.5f}'.format(calibrated_psi),
        flow_window_seconds,
        '' if slope_psi_per_min is None else '{:+.5f}'.format(slope_psi_per_min),
        '' if flow_gpm is None else '{:+.5f}'.format(flow_gpm),
    ])
    handle.write(','.join(str(value) for value in fields) + '\n')
    handle.flush()
    return True


def _render_pressure_calibration(batch, direction, gauge_psi, flow_window_seconds,
                                 flow_evidence, filename, capture_id):
    """Render the completed prior batch at the start of the next anchored cycle."""
    _qual_button(40, 92, 225, 72, direction.upper(),
                 GREEN if direction == 'rising' else YELLOW)
    _qual_button(285, 92, 130, 72, '- PSI', BLUE)
    draw_label('{:.1f} PSI      '.format(gauge_psi), 440, 106,
               M5.Lcd.FONTS.DejaVu40, WHITE)
    _qual_button(675, 92, 130, 72, '+ PSI', BLUE)
    _qual_button(835, 92, 130, 72, 'WIN -', BLUE)
    _qual_button(985, 92, 210, 72, 'WIN +', BLUE)
    draw_label('Flow window: {} s       '.format(flow_window_seconds), 835, 172,
               M5.Lcd.FONTS.Montserrat24, CYAN)

    fields = _calibration_batch_text(batch)
    positions = ((45, 225), (430, 225), (815, 225),
                 (45, 305), (430, 305), (815, 305))
    for text, position in zip(fields, positions):
        draw_label(text + '               ', position[0], position[1],
                   M5.Lcd.FONTS.Montserrat24, WHITE if '--' not in text else YELLOW)
    calibrated_psi = (calibrated_psi_from_raw_count(batch.get('average_raw_count'))
                      if isinstance(batch, dict) else None)
    slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                         if isinstance(flow_evidence, dict) else None)
    flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                if isinstance(flow_evidence, dict) else None)
    draw_label('Calibrated: {} PSI | slope: {} PSI/min       '.format(
        '--' if calibrated_psi is None else '{:.3f}'.format(calibrated_psi),
        '--' if slope_psi_per_min is None else
        '{:+.3f}'.format(slope_psi_per_min)),
        45, 385, M5.Lcd.FONTS.Montserrat24, CYAN)
    draw_label('Derived flow: {} GPM       '.format(
        'unavailable' if flow_gpm is None else '{:+.3f}'.format(flow_gpm)),
        580, 385, M5.Lcd.FONTS.Montserrat24,
        YELLOW if flow_gpm is None else (GREEN if flow_gpm >= 0 else BLUE))
    _qual_button(40, 480, 760, 145, 'CAPTURE DISPLAYED BATCH', GREEN)
    _qual_button(870, 480, 325, 145, 'BACK', RED)
    draw_label('Raw counts | measured fresh at 15 SPS | direction is capture metadata only',
               45, 650, M5.Lcd.FONTS.Montserrat18, CYAN)
    draw_label('{} | captures: {}       '.format(filename, capture_id), 45, 685,
               M5.Lcd.FONTS.Montserrat18, CYAN)


def run_pressure_calibration():
    """Continuously show five fresh raw counts; save only an explicit displayed batch."""
    _qual_wait_release()
    filename = qualification_filename('pressure-cal')
    handle = None
    gauge_psi = QUAL_CALIBRATION_START_PSI
    direction = QUAL_CALIBRATION_START_DIRECTION
    flow_window_seconds = QUAL_FLOW_WINDOW_DEFAULT_SECONDS
    capture_id = 0
    history = []
    completed_batch = None
    displayed_batch = None
    displayed_flow_evidence = None
    next_cycle_ms = time.ticks_ms()
    was_down = False
    _qual_title('GAUGE CALIBRATION')

    while True:
        now_ms = time.ticks_ms()
        if time.ticks_diff(now_ms, next_cycle_ms) >= 0:
            # This exact ordering is intentional: draw the fully completed
            # prior batch at the cycle boundary, then measure the next batch.
            displayed_batch = completed_batch
            displayed_flow_evidence = pressure_flow_evidence(
                history, displayed_batch, flow_window_seconds)
            _render_pressure_calibration(
                displayed_batch, direction, gauge_psi, flow_window_seconds,
                displayed_flow_evidence, filename, capture_id)
            completed_batch = _acquire_calibration_batch()
            if completed_batch['average_raw_count'] is not None:
                history.append(completed_batch)
                # 30 seconds is the largest selectable horizon. Keep one
                # older endpoint to make an exact boundary regression possible.
                current_midpoint = completed_batch['midpoint_ticks_ms']
                history = [item for item in history if time.ticks_diff(
                    current_midpoint, item['midpoint_ticks_ms']) <=
                    (QUAL_FLOW_WINDOW_MAX_SECONDS * 1000 + QUAL_SAMPLE_PERIOD_MS)]
            next_cycle_ms = time.ticks_add(next_cycle_ms, QUAL_SAMPLE_PERIOD_MS)
            if time.ticks_diff(time.ticks_ms(), next_cycle_ms) >= 0:
                # Processing was slower than the schedule.  Restart the
                # anchor from real time rather than claiming skipped seconds.
                next_cycle_ms = time.ticks_ms()

        point, was_down = _qual_tap(was_down)
        if _in_button(point, 40, 92, 225, 72):
            direction = 'falling' if direction == 'rising' else 'rising'
        elif _in_button(point, 285, 92, 130, 72):
            gauge_psi -= 1.0
        elif _in_button(point, 675, 92, 130, 72):
            gauge_psi += 1.0
        elif _in_button(point, 835, 92, 130, 72):
            flow_window_seconds = max(
                QUAL_FLOW_WINDOW_MIN_SECONDS, flow_window_seconds - 1)
        elif _in_button(point, 985, 92, 210, 72):
            flow_window_seconds = min(
                QUAL_FLOW_WINDOW_MAX_SECONDS, flow_window_seconds + 1)
        elif _in_button(point, 870, 480, 325, 145):
            if handle is not None:
                handle.close()
            _qual_wait_release()
            return
        elif _in_button(point, 40, 480, 760, 145):
            if displayed_batch is not None:
                if handle is None:
                    handle = _open_calibration_log(filename)
                capture_flow_evidence = pressure_flow_evidence(
                    history, displayed_batch, flow_window_seconds)
                if _write_calibration_capture(
                        handle, capture_id + 1, displayed_batch, direction,
                        gauge_psi, flow_window_seconds, capture_flow_evidence):
                    capture_id += 1
                    gauge_psi += 1.0 if direction == 'rising' else -1.0
        time.sleep_ms(20)


def run_pressure_fill():
    """Append an uninterrupted local ADC + Shelly EM fill trace at about 1 Hz."""
    _qual_wait_release()
    filename = qualification_filename('pressure-fill')
    handle = open(filename, 'w')
    handle.write('sample_number,pressure_elapsed_ms,adc_start_ticks_ms,'
                 'adc_end_ticks_ms,adc_midpoint_ticks_ms,'
                 's1_raw_count,s2_raw_count,s3_raw_count,s4_raw_count,'
                 's5_raw_count,average_raw_count,calibrated_psi,'
                 'flow_window_seconds,pressure_slope_psi_per_min,'
                 'estimated_flow_gpm,'
                 'adc_available,shelly_start_ticks_ms,shelly_end_ticks_ms,'
                 'pump_running_derived,power_w,voltage_v,shelly_available,'
                 'shelly_valid\n')
    handle.flush()
    _qual_title('UNINTERRUPTED FILL RUN', 'Local timing and sampling | {}'.format(filename))
    _qual_button(920, 510, 300, 150, 'STOP', RED)
    draw_label('Recording begins now. STOP closes the CSV and returns.',
               48, 115, M5.Lcd.FONTS.Montserrat24, CYAN)
    started_ms = time.ticks_ms()
    next_sample_ms = started_ms
    sample_count = 0
    pump_running = None
    flow_window_seconds = QUAL_FLOW_WINDOW_DEFAULT_SECONDS
    pressure_history = []
    was_down = False

    while True:
        point, was_down = _qual_tap(was_down)
        if _in_button(point, 920, 510, 300, 150):
            handle.close()
            _qual_wait_release()
            return

        now = time.ticks_ms()
        if time.ticks_diff(now, next_sample_ms) >= 0:
            batch = _acquire_calibration_batch()
            adc_start_ticks_ms = batch['start_ticks_ms']
            adc_end_ticks_ms = batch['end_ticks_ms']
            adc_midpoint_ticks_ms = batch['midpoint_ticks_ms']
            average_raw_count = batch['average_raw_count']
            calibrated_psi = calibrated_psi_from_raw_count(average_raw_count)
            if average_raw_count is not None:
                pressure_history.append(batch)
                pressure_history = [item for item in pressure_history
                                    if time.ticks_diff(
                                        adc_midpoint_ticks_ms,
                                        item['midpoint_ticks_ms']) <=
                                    (flow_window_seconds * 1000 +
                                     QUAL_SAMPLE_PERIOD_MS)]
            flow_evidence = pressure_flow_evidence(
                pressure_history, batch, flow_window_seconds)
            slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                                 if isinstance(flow_evidence, dict) else None)
            flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                        if isinstance(flow_evidence, dict) else None)
            pressure_elapsed_ms = time.ticks_diff(
                adc_midpoint_ticks_ms, started_ms)
            shelly_start_ticks_ms = time.ticks_ms()
            shelly = read_shelly()
            shelly_end_ticks_ms = time.ticks_ms()
            shelly_available = isinstance(shelly, dict)
            power_w = shelly.get('power') if shelly_available else None
            voltage_v = shelly.get('voltage') if shelly_available else None
            is_valid = shelly.get('is_valid') is True if shelly_available else False
            if not is_valid:
                power_w = None
                voltage_v = None
            pump_running = qualification_pump_running(power_w, pump_running)
            reported_pump_running = pump_running if power_w is not None else None
            sample_count += 1
            fields = [
                sample_count, pressure_elapsed_ms,
                adc_start_ticks_ms, adc_end_ticks_ms,
                adc_midpoint_ticks_ms]
            fields.extend('' if value is None else value
                          for value in batch['raw_samples'])
            fields.extend([
                '' if average_raw_count is None else
                '{:.3f}'.format(average_raw_count),
                '' if calibrated_psi is None else '{:.5f}'.format(calibrated_psi),
                flow_window_seconds,
                '' if slope_psi_per_min is None else
                '{:+.5f}'.format(slope_psi_per_min),
                '' if flow_gpm is None else '{:+.5f}'.format(flow_gpm),
                1 if average_raw_count is not None else 0,
                shelly_start_ticks_ms, shelly_end_ticks_ms,
                '' if reported_pump_running is None else (1 if reported_pump_running else 0),
                '' if power_w is None else power_w,
                '' if voltage_v is None else voltage_v,
                1 if shelly_available else 0,
                1 if is_valid else 0])
            handle.write(','.join(str(value) for value in fields) + '\n')
            handle.flush()
            draw_label('Elapsed {:>5.1f} s | samples {}          '.format(
                pressure_elapsed_ms / 1000, sample_count), 48, 205,
                M5.Lcd.FONTS.DejaVu40, WHITE)
            draw_label('ADC AVG: {} counts          '.format(
                'UNAVAILABLE' if average_raw_count is None else
                '{:.1f}'.format(average_raw_count)),
                48, 285, M5.Lcd.FONTS.DejaVu40,
                RED if average_raw_count is None else WHITE)
            draw_label('Calibrated: {} PSI | {} s slope: {} PSI/min          '.format(
                '--' if calibrated_psi is None else '{:.3f}'.format(calibrated_psi),
                flow_window_seconds,
                '--' if slope_psi_per_min is None else
                '{:+.3f}'.format(slope_psi_per_min)),
                48, 355, M5.Lcd.FONTS.Montserrat24,
                RED if calibrated_psi is None else CYAN)
            draw_label('Pump: {} | Power: {} W | Flow est: {} GPM          '.format(
                'UNKNOWN' if reported_pump_running is None else ('RUNNING' if reported_pump_running else 'STOPPED'),
                '--' if power_w is None else round(power_w),
                '--' if flow_gpm is None else '{:+.2f}'.format(flow_gpm)),
                48, 420, M5.Lcd.FONTS.Montserrat24,
                RED if not shelly_available else CYAN)
            next_sample_ms = time.ticks_add(next_sample_ms, QUAL_SAMPLE_PERIOD_MS)
            completed_ms = time.ticks_ms()
            if time.ticks_diff(completed_ms, next_sample_ms) >= 0:
                # Do not add a fictitious idle second after an overrun. The
                # next local cycle begins promptly; recorded timing remains
                # the authority for later flow analysis.
                next_sample_ms = completed_ms
        time.sleep_ms(30)


def run_pressure_qualification():
    """Run the local-only utility until normal monitoring is explicitly chosen."""
    log('Pressure qualification selected; CPU A and CPU B are not started')
    _qual_wait_release()
    was_down = False
    while True:
        _qual_title('PRESSURE QUALIFICATION', 'Local timing | no network | reboot to exit')
        _qual_button(45, 170, 550, 240, 'GAUGE CALIBRATION', GREEN)
        _qual_button(685, 170, 550, 240, 'FILL RUN', BLUE)
        _qual_button(400, 505, 480, 130, 'RESTART NORMAL', YELLOW)
        draw_label('CSV files are stored on Tab5 flash and named on each screen.',
                   330, 665, M5.Lcd.FONTS.Montserrat18, CYAN)
        while True:
            point, was_down = _qual_tap(was_down)
            if _in_button(point, 45, 170, 550, 240):
                run_pressure_calibration()
                was_down = False
                break
            if _in_button(point, 685, 170, 550, 240):
                run_pressure_fill()
                was_down = False
                break
            if _in_button(point, 400, 505, 480, 130):
                _qual_title('RESTARTING', 'Leave the screen untouched to enter normal monitoring.')
                time.sleep_ms(800)
                reset()
            time.sleep_ms(35)


# Retained but not currently called by either run. Both are tested helpers from
# the qualification work rather than accidental dead code, so they move with the
# utility they belong to instead of being deleted with the genuinely unreachable
# names M6.41 removed.

def summarize_adc_samples(samples):
    """Return the median and full range of valid local filtered ADC samples."""
    valid = [value for value in samples
             if isinstance(value, int) and not isinstance(value, bool)]
    if not valid:
        return None
    valid.sort()
    return {
        'count': len(valid),
        'representativeCounts': valid[len(valid) // 2],
        'spreadCounts': valid[-1] - valid[0],
    }


def estimated_flow_gpm(history, current_batch, window_seconds):
    """Return signed derived tank flow for a valid real-time window."""
    evidence = pressure_flow_evidence(history, current_batch, window_seconds)
    return None if evidence is None else evidence['estimated_flow_gpm']


run_pressure_qualification()
