# Release: 2026-08-22 — extract Netlify publishing without behavior changes.

import time
import requests

from device_secrets import INGEST_TOKEN


DEVICE_ID = 'shelly-em-well'
INGEST_URL = 'https://pilot--well-pump-control.netlify.app/.netlify/functions/ingest-power'
PUBLISH_TIMEOUT_S = 3


def log(msg):
    print('[well-pilot] {}'.format(msg))


def format_timestamp_utc():
    t = time.localtime()  # RTC is set directly to UTC by ntptime.settime(), no tz offset applied
    return '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
        t[0], t[1], t[2], t[3], t[4], t[5])


def publish_sample(sample, reason):
    body = {
        'schemaVersion': 1,
        'deviceId': DEVICE_ID,
        'observedAt': format_timestamp_utc(),
        'publishReason': reason,
        'power': sample.get('power', 0.0),
        'reactive': sample.get('reactive', 0.0),
        'pf': sample.get('pf', 0.0),
        'voltage': sample.get('voltage', 0.0),
        'is_valid': bool(sample.get('is_valid', False)),
        'total': sample.get('total', 0.0),
        'total_returned': sample.get('total_returned', 0.0),
    }
    try:
        r = requests.post(INGEST_URL, json=body, headers={
            'Content-Type': 'application/json',
            'X-Pilot-Key': INGEST_TOKEN,
        }, timeout=PUBLISH_TIMEOUT_S)
        ok = 200 <= r.status_code < 300
        if not ok:
            try:
                detail = r.text[:140]
            except Exception:
                detail = ''
            log('Netlify HTTP {} {}'.format(r.status_code, detail))
        r.close()
        return ok
    except Exception as e:
        log('Netlify publish error: {}'.format(e))
        return False

