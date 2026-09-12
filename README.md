# sim-remote

Stream a booted iOS simulator to the browser and drive it with real touch input —
so teammates without a Mac can poke at a build.

- 30fps H264 video at full resolution, ~118 KB/s per viewer
- 2–3ms input latency (tap, drag, scroll, long-press, keyboard, hardware buttons, rotation)
- Many viewers, one driver at a time

## Requirements

- macOS 15+, Xcode 26+
- A browser with WebCodecs: Chrome, Edge, Firefox 130+, or Safari 16.4+

Node, `idb_companion` and [aube](https://github.com/aubepkg/aube) (the package
manager) are all pinned in `mise.toml`:

```bash
mise install          # tools
mise run install      # node dependencies
```

No Homebrew tap is needed — `idb_companion` comes from idb's own GitHub
release. If you prefer Homebrew, `brew tap facebook/fb && brew install
idb-companion` also works; whichever is first on `PATH` wins.

## Run

Boot a simulator first (Xcode, or `xcrun simctl boot <udid>`), then:

```bash
mise run dev
```

That builds the client and starts the server, printing a URL with a token.

### Tasks

| Task | What it does |
|---|---|
| `mise run dev` | Build the client, then start the server |
| `mise run server` | Start the server without rebuilding |
| `mise run build` | Build the browser client |
| `mise run test` | Unit tests — no simulator needed |
| `mise run test:live` | Integration tests against a booted simulator |
| `mise run typecheck` | Typecheck without emitting |
| `mise run check` | Typecheck and unit tests |
| `mise run install` | Install node dependencies |
| `mise run sims` | List booted simulators |

Server options pass straight through:

```bash
mise run dev -- --port 9000 --host 127.0.0.1
```

Tasks run inside mise's environment, so Node and `idb_companion` are on `PATH`
without needing shell activation.

The server prints URLs containing a generated token:

```
sim-remote ready

  On this Mac:  http://localhost:8080/?token=ab12…

  On your network:
    http://192.168.1.131:8080/?token=ab12…
```

The token is exchanged for an `HttpOnly` session cookie on first load, so later
URLs stay clean.

> **Video does not play over plain `http://` from another machine.** Browsers
> expose WebCodecs (and `crypto.randomUUID`) only in a *secure context* — https,
> or `localhost`, which is exempt. The network URLs above will load the page and
> then tell you exactly this. Until TLS is added, the localhost URL is the one
> that works.

Note that the bind address is not itself browsable: `0.0.0.0` means "listen on
every interface", and pasting it into a browser gives a blank page in Safari and
a page that never connects in Chrome. That is why the server prints real URLs.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `0.0.0.0` | Bind address. Use `127.0.0.1` for local-only. |
| `--port` | `8080` | Port. |
| `--token` | generated | Fix the token instead of generating one. |
| `--no-auth` | off | Disable auth entirely. |

`--no-auth` means anyone who can reach the port can drive your simulator. On a
shared network, leave auth on.

## Control model

One person drives; everyone else watches.

- If nobody is driving, the first person to touch the screen takes control.
- If someone *is* driving, others see "Alice is driving · Take control".
  Clicking transfers control immediately — no approval, no waiting.
- Disconnecting releases control.

If control changes while the outgoing driver is mid-gesture, the server lifts
their finger first, so the simulator is never left with a stuck touch.

## Input

| Interaction | How |
|---|---|
| Tap, drag, scroll, long-press | Mouse or touch on the canvas |
| Pinch | Trackpad pinch, or two fingers on a touchscreen |
| Typing | Just type — keystrokes go to the focused field |
| Home / Lock / Siri | Buttons above the screen |
| Rotate | Rotate button, cycling portrait → landscape left → landscape right |

Rotation is handled in the browser. iOS rotates the UI *inside* a fixed
portrait framebuffer, so the video never changes shape — the picture simply
arrives turned 90°. The client therefore rotates each frame as it draws it, so
the canvas takes the real landscape shape and the bezel rotates with it, and the
server reports the live point space (402×874 becomes 874×402) so touches still
land where they are aimed. Upside-down portrait is left out of the cycle because
most iPhone apps refuse it.

Pinch is the one gesture that cannot be streamed live. idb's `HIDTouch` carries
no finger identifier, so only one touch point exists at a time and two fingers
cannot be tracked continuously the way a drag is. Multi-touch has to go through
idb's canned `HIDPinch`, so the browser accumulates the whole gesture and sends
it once — debounced for trackpads, emitted on release for touchscreens.

## Development

```bash
mise run test       # unit tests, no simulator needed
mise run test:live  # integration tests, needs a booted simulator
mise run check      # typecheck + unit tests
```

Dependencies are managed with `aube`, which reads and writes the existing
`package-lock.json` in place — `npm` still works if you prefer it.

Live tests assert through the accessibility tree rather than screenshot diffs:
springboard gestures animate and settle back to a pixel-identical screen, so
image hashing produces false negatives.

## How it works

```
Browser  ──WS /video──  H264 NAL units  ──►  WebCodecs ──► canvas
         ──WS /ws─────  JSON input      ──►  arbiter   ──► HID stream
                                  │
                              Node server
                                  │ gRPC over unix socket
                            idb_companion ──► Simulator
```

One companion, one HID stream and one video stream per simulator, regardless of
viewer count — so extra viewers cost bandwidth, not simulator load. A joining
viewer is sent the cached SPS/PPS so its decoder can configure, then waits for
the next keyframe (at most a second) before painting.

A stale keyframe is deliberately *not* replayed to a joiner: the deltas after it
reference frames that viewer's decoder never saw, which corrupts the picture and
then freezes it. Note also that idb's `key_frame_rate` is an interval in
**seconds**, not frames.

Note that HID coordinates are in **points**, not pixels (`describe()` reports
pixels plus a density factor).

## Why idb rather than axe

This started as a wrapper around [axe](https://github.com/cameroncooke/axe).
Measured on an iPhone 17 Pro simulator:

| | axe 1.8.0 | idb 1.5.7 |
|---|---|---|
| Tap latency | ~1080 ms | **2–3 ms** |
| Video | MJPEG 6.7fps @ 0.5 scale | H264 **30.5fps** @ 1.0 scale |
| Bandwidth | ~850 KB/s | **118 KB/s** |

The difference is structural: axe is a CLI for one-shot automation, reloading
private frameworks and re-running an orientation probe on every invocation
(~0.8–1.0s per step, even inside a single `batch`), and `batch --stdin` buffers
until EOF so there is no persistent-session workaround. idb's companion is a
long-lived daemon holding an open HID stream.

See `docs/superpowers/specs/` for the full design.
