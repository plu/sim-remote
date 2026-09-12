# iOS Simulator Web Remote — Design

**Date:** 2026-09-11
**Status:** Approved design, ready for implementation planning

## Problem

Teammates without a Mac — QA, design, PM — cannot poke at an iOS build. Getting
feedback means screen-sharing calls or exporting builds to real devices. We want
a web page that streams a booted simulator's display and accepts real touch
input, reachable from any browser on the office LAN.

## Goals

- Stream a booted simulator's display to multiple concurrent viewers in a browser.
- Accept real interaction: tap, drag/scroll, long-press, keyboard, hardware
  buttons, rotation.
- One person drives at a time; everyone else watches.
- Run on a developer's Mac, reachable over LAN.

## Non-goals (v1)

Booting or creating simulators; installing or uploading builds; session
recording; log streaming; file transfer; physical devices; WebRTC; multi-touch
beyond pinch.

## Foundation decision: idb, not axe

The project began as a wrapper around [axe](https://github.com/cameroncooke/axe).
Measurement showed axe is architecturally unsuited to interactive use, and
[idb](https://github.com/facebook/idb) is purpose-built for it. Both are MIT.

Measured on this machine (Xcode 26.5, iPhone 17 Pro simulator, 1206x2622):

| | axe 1.8.0 | idb 1.5.7 |
|---|---|---|
| Tap latency | ~1080 ms | **2–3 ms** |
| Sustained input | not possible (~1s/event) | **0.09 ms/event** |
| Video | MJPEG 6.7fps @ 0.5 scale | H264 **30.5fps** @ 1.0 scale |
| Bandwidth | ~850 KB/s | **118 KB/s** |
| Time to first frame | — | 69 ms |
| Architecture | process spawn per event | persistent gRPC daemon |

The gap is structural, not incidental. axe is a CLI for scripted one-shot
automation: every invocation reloads private frameworks and re-runs an
orientation probe. Verbose tracing shows the HID injection itself takes 9ms and
the orientation probe ~0.8–1.0s, repeated **per step** even inside a single
`batch`. `axe batch --stdin` buffers until EOF, so there is no persistent-session
escape hatch. idb's companion is a long-lived daemon holding an open,
client-streaming HID connection — exactly the shape of an interactive remote.

### Consequences accepted

- **Install cost.** `brew tap facebook/fb && brew install idb-companion`
  (71MB), plus supervising a companion process per simulator — versus axe's
  single binary.
- **H264 decoding in the browser.** idb emits Annex-B H264, so the client needs
  WebCodecs `VideoDecoder` rather than a trivial `<img>` MJPEG tag. MJPEG is
  **not** a fallback: VideoToolbox on Apple Silicon has no MJPEG encoder and the
  companion fails with `-12902` (`kVTParameterErr`) for every MJPEG request.
  WebCodecs covers Chrome/Edge, Firefox 130+, Safari 16.4+.

## Architecture

```
Browser (device view)
  |   WS /ws/:udid    -> JSON input + control events
  |   WS /video/:udid <- binary H264 NALUs
  v
Node + TypeScript server
  |   gRPC over unix domain socket
  v
idb_companion (one per simulator) -> private frameworks -> Simulator
```

### Components

**CompanionSupervisor** — lists booted simulators, spawns one `idb_companion`
per selected simulator on a unix domain socket, health-checks it, restarts on
crash, reaps idle companions. Owns all child-process lifecycle.

**IdbClient** — typed wrapper over the vendored `idb.proto`: `describe()`,
`hid()` (long-lived client stream), `video_stream()`, `accessibility_info()`,
`screenshot()`. The only module aware that protobuf exists.

**SessionHub** — one per simulator. Owns exactly one HID stream and one video
stream regardless of viewer count, and fans video out to N subscribers. Viewer
count does not multiply simulator load.

**ControlArbiter** — owns `controller: ClientId | null` and enforces that only
the controller's input reaches the HID stream.

**HTTP/WS server** — serves the static app and the two socket endpoints.

**Browser client** — WebCodecs decoder to canvas, gesture recognizer, device
chrome (hardware buttons, rotation), control badge.

## Data flow

### Video

Companion -> server parses Annex-B NAL units, caching SPS/PPS -> broadcast to
subscribers. A joining viewer immediately receives cached SPS/PPS so its decoder
can configure, then waits for the next keyframe before rendering.

**A stale keyframe must never be replayed to a joiner.** An earlier design did
this to avoid the wait, but the deltas that follow reference frames the joiner's
decoder never saw: the picture corrupts, the decoder errors, and it then freezes
waiting for a keyframe that may be far off.

Stream parameters: `format: H264`, `fps: 30`, `scale_factor: 1.0`,
`avg_bitrate: 4_000_000`, and `key_frame_rate: 1`. Note that `key_frame_rate` is
an **interval in seconds, not a frame count** — measured: 30 yields one keyframe
per 30s, while 1 yields one per second, which bounds a joiner's wait.

Scale factors that yield odd pixel dimensions must be rejected: 1206x2622 at
0.5 gives 603x1311 and the compression session fails with `-12902`. The server
rounds requested scales to even output dimensions.

### Input

Pointer events -> gesture recognizer -> point coordinates -> JSON over WS ->
`ControlArbiter` check -> write into the shared HID stream. At 0.09 ms/event the
server forwards at full pointer rate without batching.

## Coordinates

**HID coordinates are in points, not pixels.** For this device the screen is
1206x2622 pixels at density 3, so the point space is 402x874, matching the
accessibility tree's root frame. `describe()` returns pixels and density; the
server divides and publishes point dimensions; the client normalizes canvas
position into that space. Verified empirically: tapping the accessibility frame
centre of a dialog button in points dismissed the dialog; the same numbers
interpreted as pixels hit an unrelated widget. Getting this inverted is a silent
misalignment bug, so it is stated explicitly here.

## Control model

One controller, everyone else view-only.

- **Claim by interaction.** If no one is driving, the first person to touch the
  screen becomes controller. There is no empty-chair state.
- **Instant takeover.** When someone is driving, others see
  "Alice is driving · Take control". Clicking transfers immediately and toasts
  the previous controller. No approval step.
- **Release on disconnect.**
- **Stuck-finger safety.** If control changes while the outgoing controller has
  a pointer down, the server synthesizes an `UP` at their last known point
  before accepting input from the new controller. Without this the simulator is
  left with a held touch for every viewer.
- Clients get a display name (auto-assigned "Guest 3", editable) so the badge
  can name the driver.

Because takeover is instant, no idle timeout is needed: a driver who walks away
blocks no one.

A client is view-only only while *another* client holds control: its pointer
events are dropped, it shows a `not-allowed` cursor, and it displays the
take-control affordance. When control is free, pointer events are not dropped —
they claim control, per claim-by-interaction above.

## Gesture mapping

Validated against a live simulator.

| Interaction | Implementation |
|---|---|
| Tap | `HIDPress` DOWN then UP at the point |
| Drag / scroll | DOWN, then repeated DOWN at each new point, then UP |
| Long press | Emergent — DOWN, hold, UP in real time |
| Pinch | `HIDPinch` (centre, scale, duration) |
| Keyboard | `HIDKey` keycodes from `keydown` |
| Hardware buttons | `HIDButton`: HOME, LOCK, SIDE_BUTTON, SIRI |
| Rotation | `HIDOrientation` |

Drag and long-press need no special cases: streaming real-time DOWN events
reproduces them naturally. Confirmed by scrolling the Settings list — a streamed
drag moved the list from `General@y=293` to `Privacy & Security@y=403`.

Pinch is driven by trackpad and touchscreen alike: a `wheel` event with
`ctrlKey` set (how browsers report trackpad pinch) or two simultaneous touch
pointers, both reduced to a centre point and a scale factor. Pinch is the only
multi-touch gesture in v1.

`pointermove` is throttled to animation frames using `getCoalescedEvents()` so
no intermediate movement is lost while avoiding redundant sends.

## Error handling

- **Companion crash** — supervisor restarts it; clients show "reconnecting" and
  resubscribe to video.
- **Simulator shutdown** — detected via the companion; viewers are told.
- **Slow viewer** — drop that client's non-keyframe NALUs until the next
  keyframe rather than buffering without bound. One slow viewer must not stall
  the shared stream.
- **No WebCodecs** — explicit message naming the browser requirement, rather
  than a blank canvas.
- **Decoder desync** — on decode error, discard until the next keyframe and
  reconfigure from cached SPS/PPS.

## Security

Bind address and port are configurable. **Token auth is on by default**: the
server prints a URL containing a generated token at startup. The token arrives
as a `?token=` query parameter, which the server exchanges for an `HttpOnly`
session cookie on first load so it is not re-sent in later URLs or WS upgrades;
both WS endpoints reject upgrades lacking a valid session. On an office LAN an
unauthenticated port means anyone routable can drive the simulator. `--no-auth`
opts out. No TLS in v1 — LAN only, tunnelling is out of scope.

## Testing

**Unit** — the three pure pieces: NAL unit parser (SPS/PPS extraction, keyframe
detection), gesture recognizer (pointer sequence -> HID event sequence),
coordinate mapping (CSS -> points, including rotation).

**Control arbiter** — claim-by-interaction, takeover mid-gesture emits the
synthesized UP, disconnect releases control.

**Integration** — against a real booted simulator, asserting via the
accessibility tree rather than image diffs (screenshot hashing proved unreliable:
springboard gestures animate and settle back to an identical screen):

- a tap at a known accessibility frame opens the expected app
- a streamed drag scrolls the Settings list (element y-offset changes)
- video sustains >= 25 fps

## Stack

Node 26, TypeScript, `@grpc/grpc-js` + `@grpc/proto-loader`, `ws`, Vite with
vanilla TS on the client. `idb.proto` vendored into the repo. No frontend
framework: the UI is one canvas and a handful of buttons.

## Milestones

1. **Walking skeleton** — server, CompanionSupervisor, `describe()`; page shows
   a static screenshot of the booted simulator.
2. **Video** — H264 pipeline to live canvas via WebCodecs.
3. **Input** — tap, drag, long-press, keyboard, hardware buttons, rotation.
4. **Multi-viewer** — fan-out, control arbiter, token auth, reconnection.

## Naming

The repository was renamed from `axe-web` to `sim-remote` before implementation,
since the design uses idb rather than axe.
