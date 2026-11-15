# LOOM-8 display

The FM-1's screen in the browser, plus the note log, chord names, chord explainer, Learn mode and chord quiz. The glass is LOOM-8's built-in screen mirror (fm1-base `device/mirror.c`, SysEx commands `0x50`–`0x54`). The protocol lives in `loom_mirror.js`, separate from the page, so it can move to a shared repo later.

This is not the published Mirror page (`https://charlesvestal.github.io/fm1-loom/mirror/`), which also draws the panel and can press its controls. That page is unchanged.

## Open it

Chrome or Edge. Web MIDI with SysEx is required, and the page must be served over http (or https). A `file://` URL will not connect.

From this repository:

```
python3 -m http.server -d web/display 8765
```

Open `http://localhost:8765/display.html`. Plug in the FM-1, allow MIDI with SysEx, press Connect. The port is named `LOOM-8 FM-1`. The page sends command `0x50` op 2 to start, op 1 every two seconds to keep the mirror on (the unit stops after six seconds without one), and op 0 on Disconnect. Redraw asks for the whole screen again.

The notes under the glass are ordinary USB MIDI note on/off. Setup's NOTES is on by default; track N sends on channel N. The page treats only channel 10 as drums, so the kit (channel 1) is included in chord names.

## What this protocol does not carry

The CPU load, peak block time, late blocks, voice count and BPM strip from the other screen-mirror page is absent. Those numbers are not in commands `0x50`–`0x54`. The status line's KB/s is counted in the browser.

There is no Ask / Restore panel. That panel speaks the Skiff editor protocol, and commands 11–14 on this header are LOOM-8's sample bank.
