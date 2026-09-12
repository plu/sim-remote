#!/usr/bin/env bash
# Boot the newest available iPhone simulator and wait until it can actually
# render. Used by CI, where the device list depends on the runner image.
#
# Booting with `simctl boot` alone is not enough: without the Simulator UI the
# framebuffer is never produced, so idb's video stream yields nothing and
# accessibility returns "No translation object returned for simulator".
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
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is fine
xcrun simctl bootstatus "$UDID" -b

# Bring up the UI so the display pipeline exists.
open -a Simulator --args -CurrentDeviceUDID "$UDID" || true

# Readiness: a screenshot proves the framebuffer renders, which is exactly what
# the video stream needs. Poll rather than guess at a sleep.
shot=/tmp/sim-boot-check.png
for i in $(seq 1 60); do
  if xcrun simctl io "$UDID" screenshot "$shot" >/dev/null 2>&1; then
    size=$(stat -f%z "$shot" 2>/dev/null || echo 0)
    if [ "$size" -gt 20000 ]; then
      echo "Simulator rendering after ${i}s (screenshot ${size} bytes)"
      xcrun simctl list devices booted
      exit 0
    fi
  fi
  sleep 1
done

echo "Simulator booted but never produced a usable screenshot" >&2
xcrun simctl list devices booted >&2
exit 1
