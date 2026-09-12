#!/usr/bin/env bash
# Boot the newest available iPhone simulator and wait until it is usable.
# Used by CI, where the exact device list depends on the runner image.
set -euo pipefail

UDID=$(xcrun simctl list devices available -j | python3 -c '
import json, sys

devices = json.load(sys.stdin)["devices"]
best = None
for runtime, entries in devices.items():
    if "iOS" not in runtime:
        continue
    for d in entries:
        if d.get("isAvailable") and d["name"].startswith("iPhone"):
            key = (runtime, d["name"])
            if best is None or key > best[0]:
                best = (key, d["udid"])

if best is None:
    sys.exit("no available iPhone simulator")
print(best[1])
')

echo "Booting $UDID"
# Already-booted is not an error.
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl list devices booted
