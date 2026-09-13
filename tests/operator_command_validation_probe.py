"""Validate one JSON command through the actual CPU B admission path.

The Pilot RTDB emulator regression invokes this small host adapter after reading
the command back from the emulator. It stubs only the Tab5 hardware modules; the
validator and queue admission code are loaded from production tab5/cloud.py.
"""

import json
import sys

from test_tab5_cloud_transport import load_cloud


def main():
    command = json.load(sys.stdin)
    cloud, _requests = load_cloud()
    cloud._session_id = command.get("targetSessionId")
    cloud._pending_operator_command = None
    cloud._last_queued_operator_command_id = None
    cloud._last_delivered_command_sequence = 0
    if not cloud._queue_operator_command(command):
        return 1
    admitted = cloud.take_operator_command()
    if admitted != command:
        return 2
    json.dump({"accepted": True, "commandSequence": admitted["commandSequence"]},
              sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
