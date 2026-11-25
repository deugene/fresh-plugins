# Investigation: viewing images in Fresh

**Ticket.** "Create a Fresh editor plugin for viewing images." It is the second package in `deugene/fresh-plugins`.

**Context.** Date: 2026-11-25.

- Installed editor: `fresh 0.5.9` at `/opt/homebrew/bin/fresh`.
- Upstream master was checked up to `a35ceb35d` (2026-11-24), 86 commits past v0.5.9 (`d9c76f7b1`).
- Tools on this machine, for P1–P27: `ffmpeg` 8.1 (`/usr/local/bin`), macOS `sips` and `base64`, Node 24.18.0, tmux 3.8. Not installed: ImageMagick, chafa, libvips.
- P28 added ImageMagick 7.1.2-36 from Homebrew. Its install upgraded `x265` and broke the 8.1 build, so P29–P31 use Homebrew's `ffmpeg` 9.1 (`/opt/homebrew/bin`). P30 also runs Debian's ffmpeg 5.1 and 7.1 in containers on colima.
- The package rules in the root `CLAUDE.md` apply: target 0.5.9, use only APIs in `types/fresh.d.ts`, and vendor everything.

**Path shorthands**

| Shorthand | Path |
|---|---|
| `DTS` | `~/.config/fresh/types/fresh.d.ts` (v0.5.9) |
| `SRC` | v0.5.9 source, `/tmp/fresh-investigate/v059/crates/`. `fe/` is `fresh-editor/src`, `fec/` is `fresh-editor-core/src` |
| `UP` | upstream master clone, `/tmp/fresh-investigate/fresh/` |
| `EP` | embedded built-in plugins, `~/Library/Caches/fresh/embedded-plugins/4236c9a224cc1cfa/` |
| `IP` | the third-party `image-preview` source, `/tmp/fresh-investigate/imgprev/` |

Probes ran in `/tmp/img-live/` (inside Fresh) and `/tmp/imgprobe/` (converters and decoders outside it). Their results are in §8.

## 1. Does anything already do this?

**Fresh itself: no** (high).

- A PNG, JPEG or GIF opens as a read-only byte view (§2, P1).
- Upstream master adds `openInSystemApp(path)` (#3838, 2026-11-22), which hands the file to the OS viewer. It is master-only and draws nothing in the editor.

**Registry and `sinelaw/fresh-plugins`: no** (high). The registry `plugins.json` (updated 2026-10-13) lists 9 packages, and none of them handles images.

**Third party: `asukaminato0721/fresh-plugins#image-preview` does it, with flaws** (high, read in source).

- It is a fork of `sinelaw/fresh-plugins`. Its only commit is `08e8174` (2026-10-13), and its author linked it from #2617. It is not in the registry.
- **Getting pixels.** It runs one of two tools through `spawnProcess`:
  - `chafa --format=symbols --colors=full --symbols=block`, and then parses chafa's SGR codes (`IP/lib/render.ts:102-152`);
  - or ImageMagick `magick path[0] -resize … txt:-`, and then parses the `x,y: … #rrggbb` lines (`:190-226`).
  - Neither tool ships with macOS or with a default Linux install.
- **Drawing.** It draws `▀` half blocks, one per cell, and colours them with `inlineOverlays` (`:55-65`, `:208-224`).
- **Where the image shows.** On `after_file_open` it opens a separate `createVirtualBuffer` (`IP/image-preview.ts:144,283`), so every image ends up with two tabs. The byte view also flashes before the preview appears; both flaws are stated in #3824.
- **Redraws** follow `viewport_changed`, `buffer_activated` and `config_changed`.
- **Keys.** `q`, `r`, and `b` (show the bytes).
- **APIs.** Every API it calls is in the 0.5.9 DTS.

**Upstream's position** (high).

- **#521** (kitty images) was closed. The maintainer said it "would only work for a subset of users".
- **PR #2325** proposed a kitty `placeImage` API and was closed unmerged on 2026-06-19.
- **PR #2093** (a built-in EPUB viewer) was closed unmerged. The maintainer said "running any external program to convert arbitrary formats to text should probably be the right approach", and cited bloat and the security risk of parsing binary formats in core.
- **#3824** (open, 2026-11-19) asks for `registerFileOpener({extensions})`. It notes that `before_file_open` is declared but never fired.
- **`UP/docs/internal/lazy-file-views-design.md`** is marked "proposed (not implemented)". It plans an image viewer drawn "as text cells" in the file's own tab, through a future `createRenderedView({inTabOf…})`.

**Verdict.** No built-in or registry plugin does this, and the maintainer wants it done by external programs in plugin space. The one existing plugin proves the half-block approach on 0.5.9. Its two-tab and byte-flash flaws are avoidable with 0.5.9 APIs (§2, P7), and it needs tools most users lack. Choosing between a new plugin, a fork, or using it as it is goes to the user (§10).

## 2. Opening an image, and taking it over

**What happens today** (high).

- **Binary detection is by content, not by extension** (`fec/model/encoding.rs:254,321,381`).
  - Files under `editor.large_file_threshold_bytes` (10 MB) are read whole.
  - Larger files are sampled (first 8 KB) and stay lazily loaded (`fec/model/buffer/mod.rs:546,640,650-660`).
  - Every PNG, JPEG and GIF counts as binary. SVG opens as text.
- **The buffer** is made read-only, and the status bar says "[binary file, read-only]" (`fe/app/file_open_orchestrators.rs:432-453,1227-1232`).
- **Drawing.** Printable ASCII is drawn as itself and other bytes as `<XX>` tokens (`fe/view/ui/split_rendering/base_tokens.rs:488,588-600`).
- **Entry points.** The explorer, Quick Open and a CLI argument all take this path (P1).

**Hooks** (high, code and P2).

- **`before_file_open` never fires.** It is declared (`fresh-core/src/hooks.rs:27`), but nothing constructs it.
- **`after_file_open {path, buffer_id, window_id}`** is fire-and-forget. It arrives after the buffer is shown, and cannot cancel or redirect the open (`file_open_orchestrators.rs:1622-1648`).
- **`path` is canonical** (`/private/tmp/…` on macOS).
- **An explorer single-click opens a *preview* tab** (`name (preview) [BIN]`). It fires only `buffer_activated {buffer_id, window_id}`. `after_file_open` comes later, if Enter promotes the preview, and on the same buffer id.
- **Enter in the explorer** briefly creates and closes an extra buffer before `after_file_open`.
- **No open-with or per-extension handler API** exists in 0.5.9.

**Three ways to show the image** (high unless noted).

| Way | Result | Evidence |
|---|---|---|
| A. A buffer group in the file's own tab: `createBufferGroup(name, mode, layout, {inTabOf: fileBufferId})` | The file's tab (its name, close button and place) shows the group instead of the bytes. One tab. Closing the group shows the bytes again. | `DTS:9440-9476`; built-in precedent `EP/markdown_compose.ts:1947`; P7 |
| B. Replace the split's buffer: `createVirtualBufferInExistingSplit`, then `closeBuffer(file)` | One tab, but it is a stand-in. Opening the file again opens a second file buffer, giving two image tabs, so the plugin must dedupe by path. Features that find a file by path (rename, replace-in-files, LSP) see no buffer for it. | P2; `lazy-file-views-design.md` §3 |
| C. A separate virtual buffer (what image-preview does) | Two tabs per image | §1 |

A is the only way that keeps the file's tab as the file's. P7 found three quirks in it:

- **A single scrollable leaf draws nothing.** The text is in the panel, but nothing renders, even after a resize. A split layout works: a 1-row `fixed` header over a `scrollable` image. Cause unknown.
- **Closing the group re-fires `buffer_activated`.** After `closeBufferGroup` the file's bytes show again and `buffer_activated` fires for it. A handler that opens the group on activation reopens it at once, so the plugin needs a per-buffer "show the bytes" flag.
- **Panel buffers fire `buffer_activated` too**, with `path ""`.

**Keys and the mouse in the group** (P13, P15).

- **Mode keys work.** A mode from `defineMode(…, readOnly=true)`, given as the group's mode, receives every key it binds: `+ - 0 =`, the arrows, `h j k l`, `b`, `q`, even Ctrl+W. This holds after Quick Open, after Enter in the explorer, and after a click into the image.
  - No bound key was taken by Fresh first.
  - No arrow moved a cursor.
  - An unbound printable key shows "Editing disabled in this buffer".
- **The image panel holds the keyboard after the open.** Clicking the header does not move it. Both panels share the mode, so the focused panel matters only to `getViewport()`.
- **The host scrolls the panel itself, and that scroll does not stick.**
  - The wheel scrolls the panel 3 lines a notch and fires `viewport_changed` for the panel's split.
  - With `lineWrap:false` and content wider than the pane, Shift+wheel and the horizontal wheel scroll sideways. They fire no event.
  - Any keypress, bound or not, snaps the view back to the hidden cursor.
  - A click moves the hidden cursor, and with it the view.
  - `setSplitScroll` on a panel split does nothing.
  - **So the plugin cannot follow a wheel pan:** it is undone by the next key, and a horizontal one cannot even be observed. With content no larger than the panel there is nothing for the host to scroll.
- **Closing.** On macOS `close_tab` is Alt+W, and Ctrl+W is `select_word` (keymap `macos.json`, which inherits `default.json`). That explains P7's "Ctrl+W did nothing".
  - Alt+W closes a group's tab cleanly, and so does a mode key that calls `closeBuffer(fileBufferId)`.
  - Either way the sequence is `buffer_closed` for the file and both panels, then `buffer_group_closed`, with no stray buffers.

**Several windows** (high, read in the v0.5.9 source).

- **Group and split ids are per window.** Each window numbers its buffer groups from 0 (`fe/app/window/mod.rs:2729`, DTS 9464), and each new window gets a `SplitManager` of its own (`fe/app/window_actions.rs:983`). So two windows can show groups and splits with the same ids.
- **Buffer ids are global.** One allocator is shared by every window (`fe/app/mod.rs:584-598`, as `docs/investigations/git-sidebar.md` §11.4 found).
- **Group calls act on the active window.** `setPanelContent` looks the group up in the active window only (`fe/app/buffer_groups.rs:565-597`), and `closeBufferGroup` closes it there.
- **The plugin's own `closeBufferGroup` fires `buffer_group_closed`** (`buffer_groups.rs:705-720`), with the active window's id, just as a close by the host does.
- So a plugin keys groups and splits on (window, id), and runs group calls only while their window is active.

## 3. Painting cells

**Half blocks.** `▀` and `▄` are one cell wide (`unicode_width`, no CJK variant). The fg colour paints the top pixel and the bg colour the bottom one, giving 2 pixels per cell vertically.

**Mechanisms for a truecolor fg and bg per cell** (P3, P8, checked cell by cell with `capture-pane -e`):

| Mechanism | Works in 0.5.9 | Notes |
|---|---|---|
| Entry `inlineOverlays` with `unit:"byte"` (offset = cell × 3, since `▀` is 3 bytes) | **yes**, exact | 60×200 cells build in 33–37 ms and create in about 92 ms |
| `addOverlay(buffer, ns, start, end, {fg, bg})` per cell | **yes**, exact | 12,000 overlays in 56 ms |
| One entry per cell, each with its own `style` | yes, exact | many entries |
| Entry `inlineOverlays` with `unit:"char"` | **no** | offsets are taken as bytes, so the colours land on the wrong cells |
| Entry `segments` | **no** | the buffer comes out empty |
| SGR escapes inside entry text (`\e[38;2;…;48;2;…m▀`) | yes, exact | escapes are hidden and take no width, but the buffer is 12× larger and scrolling costs about 125 ms a step instead of 15–19 ms |

**Precedence** (`char_style.rs:94-410`).

- The current-line highlight applies only to cells without their own bg (`:345`), so it never clobbers the image (P3).
- The cursor cell is drawn reversed. `showCursors:false` hides it (P3).

**Viewport edge fade.** The editor setting `viewport_edge_fade` (default true) dims the bottom two rows when content runs past the viewport. An image no taller than its viewport avoids it (P3).

**Gutter and wrapping.**

- `showLineNumbers:false` leaves no gutter: the image starts at column 0 (P9).
- The rightmost column is the scrollbar, so the drawable width is the split width minus 1 (P4).
- Lines wrap unless `lineWrap:false` is passed (or `setLineWrap` is called on the panel split).
- `createVirtualBuffer` has no `lineWrap` option (P3).
- Option objects are strict: an unknown field throws "unknown field".

**Colour depth** (high).

- Fresh picks truecolor, 256 or 16 colours from `FRESH_COLOR_MODE`, or else `COLORTERM`/`TERM`. The default is 256 (`fec/color_support.rs:40-127`).
- The whole frame is downsampled last (`fe/app/render.rs:1307`). A plugin cannot query the mode.
- Under tmux with `TERM=xterm-256color` and no `COLORTERM`, an image is drawn in 256 colours. Master's #3861 changes the snapping, but it is master-only.

## 4. Size and resize (high, P4)

- **`getViewport()`** gives the active split's drawable area. A full-width pane of 200×58 gives 199×57: one column goes to the scrollbar, one row to the tab bar.
- **`listSplits()`**:
  - gives stale numbers right after a split is created;
  - returns `[]` while a buffer group is shown (P7);
  - `getBufferInfo(panel).splits` is `[]` too.
- **No declared API reports a panel split's size.** `setSplitLabel` with `getSplitByLabel` gives `null` too (P14).
- **While a group shows, `getViewport()` measures the focused panel's text area.**
  - With the image panel focused, which it is after the open, it reported 199×55. That matched the 55 rows × 199 cells the image panel occupies on screen.
  - The header takes 1 row plus a 1-row separator.
  - With the header focused, it reported 140×1 (P14).
- **Resize hooks.**
  - A terminal resize fires `resize {width, height}` (the whole screen).
  - Then comes one `viewport_changed {split_id, buffer_id, window_id, top_byte, top_line, width, height}` per split. For a group these are: the header panel's split, the host split (the whole pane, with the file's `buffer_id`), and the image panel's split, carrying exactly its text area (111×40 at 160×45).
  - Toggling the explorer fires the same sequence. Its `resize` carries the unchanged screen size, and the explorer takes the keyboard (P4, P14).

## 5. Getting pixels into the plugin

**No binary-safe read exists in 0.5.9** (high).

- `readFile` returns null for non-UTF-8 (`DTS:6055-6062`).
- `readFilePrefixes` and `getBufferText` decode lossily (`fe/app/plugin_offloop.rs:189`, `fe/state.rs:1953`).
- `fileStat` gives `{isFile, isDir, size, readonly}`, with no mtime (P6).

**Process output must be text** (high).

- stdout is decoded lossily, with no size cap (`fe/services/remote/spawner.rs:340,382`).
- `spawnProcess`'s `stdoutTo` writes raw bytes to a file, but the plugin cannot read them back.
- The bytes therefore have to arrive as base64, hex or ASCII.
- The runtime has no `atob`, `btoa`, `TextDecoder` or `TextEncoder`. It has `Uint8Array` and `performance.now` (P9). A hand-written base64 decoder is about 20 lines.

**External converters (fit into 200×100 and print text)** (P10, high where timed).

| Tool | Command (via `sh -c`) | Time on this machine | Availability |
|---|---|---|---|
| ffmpeg | `ffmpeg -nostdin -v error -i F -frames:v 1 -vf "scale=W:H:force_original_aspect_ratio=decrease:flags=area,format=rgba" -c:v pam -f image2pipe - \| base64` | 12 MP JPEG 102 ms, 1024² PNG 44 ms, GIF 35 ms, WebP 39 ms | optional package everywhere |
| sips (macOS) | `sips -Z <max> -s format bmp F --out $T >/dev/null && base64 -i $T; rm $T` | 28–63 ms | always on macOS; it cannot write to stdout, so it needs a temp file |
| ImageMagick | `magick 'F[0]' -auto-orient -thumbnail WxH pam:- \| base64` (`convert` on IM6) | not tested (not installed) | optional |
| chafa | `chafa -f symbols --symbols vhalf -c full -s CxR F`, which prints SGR text | not tested | optional |

Details by tool:

- **ffmpeg.**
  - PAM's ASCII header gives the width and height.
  - ffmpeg applies EXIF orientation by default (an Orientation=6 JPEG came out 75×100).
  - `-frames:v 1` takes the first GIF frame.
  - Startup alone costs 25 ms.
- **sips.**
  - Its BMP is top-down: 24-bit, or 32-bit BI_BITFIELDS (124-byte header) with straight alpha.
  - `-Z` caps only the longest side, so the plugin scales again in JS.
  - It honours EXIF orientation (150×200 from the Orientation=6 file).
- **base64.**
  - macOS `base64 <file>` fails (exit 64), so pass `-i <file>` or read stdin.
  - Linux coreutils wraps at 76 characters unless given `-w0`. Reading stdin and stripping `\n` in JS works on both.
- **Inside Fresh (P5).**
  - `spawnHostProcess("sh", ["-c", "ffmpeg … | base64"])` returned 120,001 characters in 113–191 ms.
  - Decoding them in QuickJS took 21–24 ms.
  - Building 75 rows × 200 overlays took 12–18 ms, and the create call 71–119 ms.
  - The screen pixels matched ffmpeg's.

**Pure-JS decoders to vendor** (P11, medium-high).

| Lib | License | Size | Runs without Node APIs | V8 time | QuickJS estimate (10–50× slower) |
|---|---|---|---|---|---|
| UPNG.js + fflate inflate | MIT | 31 + 33 KB | yes (inflate swapped through `UPNG.decode._inflate`) | 16 ms for 1024² | 0.2–0.8 s |
| omggif (GIF frame 0) | MIT | 32 KB | yes | 2 ms | 20–100 ms |
| jpeg-js (`useTArray:true`) | BSD-3-Clause | 40 KB | yes | about 500 ms for 12 MP | **5–25 s** |
| @stacksjs/ts-webp | MIT | 77 KB | decode path yes; very new (2026) | 32 ms | 0.3–1.6 s |
| fast-png | MIT | | **no**: calls `new TextEncoder()` when it loads | | |
| BMP | | | the npm libs use `Buffer`; a hand-written parser is about 60 lines | | |

- **A JS decode needs the whole file.** Getting it means `base64 -i` of the file, 124–165 ms for 5 MB, and then decoding the base64 in QuickJS, about 1.1 s for 5 MB (P5).
- **Decode time scales with the source pixels**, not with the target size.
- **The editor stayed responsive** during a 1.1 s decode (P5).

**Alpha, orientation and animation** (P12).

- **Alpha.** Composite RGBA over the theme's editor background in JS: `c = a·fg + (1−a)·bg`.
- **Orientation.** ffmpeg and sips honour EXIF orientation. ImageMagick needs `-auto-orient`. jpeg-js does not: the plugin would have to read tag 0x0112 itself.
- **Animated GIF.** Show the first frame only: ffmpeg `-frames:v 1`, ImageMagick `F[0]`, or omggif frame 0.

## 6. Terminal graphics protocols (high)

- Kitty (APC), iTerm2 (OSC 1337) and sixel (DCS) all need the host to write raw bytes to the terminal, to know the cell size in pixels, and to clear the image on repaint.
- 0.5.9 has no such API.
- Non-SGR escapes in buffer text are swallowed by the ANSI parser.
- The embedded terminal emulates cells only.
- Master has nothing either; the design doc lists kitty and sixel as an open question.
- Half blocks are therefore the only rendering available to a plugin.

## 7. Remote windows and workspace trust (high)

- **Paths.** A plain path resolves against the *active* window's filesystem (`fresh-core/src/api.rs:7754-7776`).
- **Bind-mounted dev containers.** The filesystem stays on the host, so `spawnHostProcess` with the host path works there (git-sidebar INV §7).
- **SSH windows.** The file is remote. `spawnHostProcess` cannot see it, and `spawnProcess` would need the converter installed on that machine. `stdoutTo` errors on both SSH and docker-exec.
- **Workspace trust.**
  - `spawnHostProcess` is gated by workspace trust (`fe/app/plugin_dispatch.rs:3858-3870`).
  - Blocked refuses every spawn.
  - Restricted refuses only commands given as a path inside the project. A bare `ffmpeg`, `sips`, `sh` or `base64` is allowed (`fe/services/workspace_trust.rs:254-285`).
  - A refused spawn returns `exit_code -1` with the reason in stderr.

## 8. Probe results

**Live probes (P1–P9).**

- **Date and versions.** 2026-11-25, Fresh 0.5.9.
- **Harness.** The isolated `HOME=/tmp/img-live/home` with `FRESH_SESSION` unset, in tmux session `imgprobe` at 200×60.
- **Probe plugin.** `/tmp/img-live/probe/img_probe.ts`, symlinked as package `img-probe`. It polls `/tmp/img-live/cmd` for commands.
- **Sample images.** `/tmp/img-live/imgs/`: `grad.png` 1024×768 and `big.jpg` 4000×3000 (5.08 MB).
- **Cell checks.** `chk.py` parses `capture-pane -e` output.

| Probe | Result |
|---|---|
| P1 | **Byte view.** From the CLI, Enter in the explorer, or Quick Open: a `grad.png [BIN]` tab shows `1 │ <89>PNG<0D>…`, with the status line "Opened grad.png [binary file, read-only]". The 5 MB JPEG opened in about 250 ms with no warning. An explorer single-click opens `big.jpg (preview) [BIN]`. |
| P2 | **Hooks.** `before_file_open` never fired. The CLI and Quick Open fire `after_file_open` and then `buffer_activated`. A preview fires only `buffer_activated`, and promoting it fires `after_file_open` on the same id. `createVirtualBufferInExistingSplit({splitId})` took 74–104 ms, and `closeBuffer(orig, true)` then left one tab. Re-opening the file gave two image tabs. |
| P3 | **Per-cell colour.** `inlineOverlays` `unit:"byte"` (offsets c×3), per-cell entries and `addOverlay` are all exact: 0 mismatches at 50×100, and 0 of 10,890 at 60×200 with `addOverlay`. `unit:"char"` lands on the wrong cells, and `segments` gives an empty buffer. The current line and the cursor never change a cell's bg. `viewport_edge_fade` dims the last two rows when content overflows. Scrolling a 60×200 image costs 15–19 ms a step. Typing next to it takes 21–30 ms, against a 10–28 ms baseline. |
| P4 | **Size.** Pane 200×58 gives viewport 199×57; side by side, 99 gives 98. A `tmux resize-window` fires `resize {width:160,height:45}`, then `viewport_changed` per split with the new width and height. Toggling the explorer also fires both. `listSplits()` is stale right after a create. |
| P5 | **Bytes in.** `base64 <f>` fails on macOS (exit 64). `base64 -i` takes 124–165 ms for 5 MB and returns 6,769,677 characters, as `wc -c` counts. The ffmpeg-to-200×150-rgb24 pipe through base64 takes 113–191 ms (120,001 characters). Decoding that in QuickJS takes 21–24 ms; the whole 5 MB takes 1.13 s, with scrolling still at 20–29 ms. Building 75×200 overlays takes 12–18 ms, and the create 71–119 ms. The first pixel matched ffmpeg. |
| P6 | **`fileStat`.** `{"isFile":true,"isDir":false,"size":5077257,"readonly":false}`, and `null` for a missing path. No mtime. |
| P7 | **Buffer group in the file's tab.** A single `scrollable` leaf renders blank (12,040 bytes in the panel, nothing drawn). A 1-row `fixed` header over a `scrollable` image works: it draws in the file's own tab with one tab (`grad.png [BIN]`), exact colours (0 of 4,000 mismatches), and about 50–120 ms to create and fill. Sampling frames every 10 ms on a re-open showed one blank frame and no byte view, then the image. It also works on a preview tab (from `buffer_activated`), and promoting the preview keeps the group. Closing the tab with its × fires `buffer_closed` for the file and both panels, then `buffer_group_closed`, and leaves no stray buffers. Ctrl+W did nothing. After `closeBufferGroup` the bytes show and `buffer_activated` fires again. `listSplits()` is `[]` while a group shows; `getViewport()` gives 199×55. |
| P8 | **SGR text.** Truecolor SGR in entry text renders exactly (0 of 10,890), with the escapes hidden. The buffer is 452,340 bytes against 36,060, the flush takes 212–252 ms against about 62 ms, and scrolling costs about 125 ms a step. |
| P9 | **Globals and gutter.** `typeof atob, btoa, Uint8Array, TextDecoder` printed `undefined undefined function undefined`. With `showLineNumbers:false`, column 0 is an image cell; the only gap is the scrollbar column on the right. |
| P13 | **Keys and the mouse in a group** (header plus image, mode `defineMode("imgv", …, readOnly=true)`). Every bound key reaches the mode: `+ - 0 = ←→↑↓ h j k l b q`, and Ctrl+W when bound. This held after Quick Open, after explorer Enter, and after a click. The image panel holds focus after the open. `focusBufferGroupPanel(gid,"hdr")` moves focus, and then `getViewport()` reports the header. The wheel scrolls the panel 3 lines a notch (`viewport_changed` on its split). Shift+wheel and the horizontal wheel scroll a 300-column line with no event. Any key, bound or not, snaps back to the hidden cursor at byte 0. A click moves the cursor, and with it the view. `setBufferCursor` pans, and the pan survives keys. `setSplitScroll(panelSplit)` does nothing. The edge fade dims the top and bottom two rows of overflowing content. |
| P14 | **Sizing.** With the image panel focused, `getViewport()` is 199×55, matching the 55 rows × 199 cells on screen (header 1 row plus a 1-row separator). With the header focused it is 140×1. No declared API reports a panel split's size. A `tmux resize-window` to 160×45 fires `resize {160,45}`, then `viewport_changed` for the header split (112×1), the host split (112×43, the file's `buffer_id`), and the image split (111×40, matching the screen). Ctrl+B fires the same sequence and focuses the explorer. |
| P15 | **Closing.** `close_tab` is Alt+W on macOS; Ctrl+W is `select_word` and does not close an ordinary tab. Alt+W on a group's tab, or a mode key calling `closeBuffer(fileBufferId)`, gives `buffer_closed` for the file, the header and the image, then `buffer_group_closed`, and leaves no stray buffers. The panels are still listed right after `flush()`, and gone after `buffer_group_closed`. |
| P16 | **Redraw cost.** ffmpeg crop+scale and fit-scale of the 12 MP JPEG to 199×114 PAM and then base64 both take 124–136 ms warm (occasionally 175–211 ms, 197–284 ms cold), so cropping saves nothing. Decoding in QuickJS takes 18–24 ms. Replacing the image in place with `setPanelContent` (57×199, byte-unit `inlineOverlays`): build 9–13 ms, set 21–28 ms, flush 47–98 ms. A whole zoom takes 256–321 ms. Frames sampled during it go straight from the old image to the new one, never blank. The panel's scroll position is kept. Overlays added with `addOverlay` are dropped by `setPanelContent`. A 1-row styled header draws in its own style with no cursor or current-line highlight, focused or not. |

**Converter and decoder probes (P10–P12).**

- **Where.** `/tmp/imgprobe/`, outside Fresh; scripts in `scripts/`, images in `img/`.
- **Timing.** Each time is the median of 5 runs.
- **Sample files.** A 4000×3000 JPEG (5.5 MB, EXIF Orientation=6), a 1024² RGBA PNG, a 480×360 30-frame GIF, a 1024×768 BMP and a 1024² lossy WebP with alpha.

| Probe | Result |
|---|---|
| P10 | **Converter pipelines.** ffmpeg to PPM/PAM and then `base64` runs in 36–102 ms. sips to BMP and then `base64` runs in 28–63 ms. Both fit within 200×100. ffmpeg's `-lowres 3` saves only about 20 ms. sips cannot write to `/dev/stdout`. This ffmpeg build decodes webp, png, gif, bmp, tiff, mjpeg and hevc. |
| P11 | **Pure-JS decoders.** UPNG+pako, UPNG+fflate, jpeg-js (`useTArray`) and omggif all ran in a Node `vm` context with no `Buffer`, `require`, `TextDecoder` or `atob`. fast-png throws when it loads. V8 times are in §5; no QuickJS binary was available, so the QuickJS figures are estimates. |
| P12 | **Orientation, frames, alpha.** On the Orientation=6 JPEG, ffmpeg gave 75×100 (133×100 with `-noautorotate`) and sips gave 150×200. ffmpeg `-frames:v 1` gives one GIF frame. ffmpeg's PAM and sips's 32-bit BMP both carry straight alpha. |

**Plan probes (P17–P33).** P17–P23 settle what the implementation plan had assumed but not checked: what `getViewport()` measures after a create, whether content of exactly the panel's size can be scrolled, the theme lookup, hidden tabs, `kill()`, and how sips and ImageMagick behave. P24 tries the pinned panel the user asked for after P18. P25 and P26 record what building found, P27 the tool cases the code review raised, P28 the ImageMagick coder check a later review asked for, and P29 the ffmpeg 9.1 re-check. P30 and P31 come from a later review: ffmpeg limited to the extension's demuxers and decoders, and the runs' files moved out of the shared temp dir. P32 and P33 come from the live verification of the finished plugin: an explorer preview that vanished, and a fringe at ffmpeg's transparent edges.

- **Date and versions.** 2026-11-25, Fresh 0.5.9.
- **Live harness (P17–P21).** `fresh --simple` with `HOME=/tmp/ivw/home` and `XDG_RUNTIME_DIR=/tmp/ivw/run`, in tmux session `ivp` at 200×60, cwd `/tmp/ivw/work`.
- **Probe plugin.** `/tmp/ivw/probe/iv_probe.ts`. It opens a header-plus-image group on `buffer_activated` the way the plan does (pre-check, then `createBufferGroup(…, {inTabOf})`, then a post-check) and logs every hook. Commands arrive through `/tmp/ivw/cmd`.
- **P22.** sips on this Mac, in `/tmp/ivw/sips/`, with a 200×150 PNG whose pixel (x, y) is `(x, y, 128)` and the P10 images. Times are the median of 5 runs.
- **P23.** Debian containers on colima (aarch64): `debian:bookworm-slim` with `imagemagick` (IM 6.9.11-60, `convert`) and `debian:trixie-slim` with `imagemagick` (IM 7.1.1-43, `magick`), both from the Debian archive.

| Probe | Result |
|---|---|
| P17 | **Area and placement after the create.** When `createBufferGroup` resolves, `getViewport()` never reports the image panel. At startup it reported the file's split (199×57, with `getActiveBufferId()` still the file). After explorer Enter, and for a group in a tab of its own, `getActiveBufferId()` was already `panels.img` and `getViewport()` reported 200×60, the whole screen. After `flush()` it was 200×60 or 199×55. **The plan's assumption that it would is contradicted:** a check for `getActiveBufferId() === panels.img` does not make the reading right. The image split's `viewport_changed` (199×55, or 139×55 with the explorer shown) arrived 5–9 ms after every create, with no resize. **Telling the tab:** `getBufferInfo(fileId).splits` includes `getActiveSplitId()` when the group is in the file's tab (`[0]`). It is `[]` when the group got a tab of its own (the tab bar then shows an extra `img ×` tab), and `getBufferInfo` is `null` when the file has closed. **Explorer Enter** fires `buffer_activated` for 2 and then 3, then `buffer_closed` for 2. The create for 2 resolves after 2 has closed. Without a post-check its group stays as an orphan `img ×` tab. With the post-check above closing it, one `grad.png [BIN]` tab is left, showing the group for 3. |
| P18 | **Content exactly the panel's size** (55 rows × 199 cells, no trailing `\n`, `lineWrap:false`). The vertical wheel, a click and keys (`x`, End, Ctrl+End, PageDown) changed no cell. Every row kept its exact colours, so there was no edge fade. **The horizontal wheel and Shift+wheel still scroll it sideways:** 8 columns a notch, and `getViewport().leftColumn` reads 8, 16, 24. No event fires. Content 198, 190 or 120 cells wide scrolls the same way. The next key snaps it back to 0. **The plan's assumption that content of exactly the panel's size gives the host nothing to scroll is contradicted** for horizontal scrolling. With `setLineWrap(…, true)` sideways scrolling stops. But a 199-cell row then wraps at 198, so the content overflows. Even 198-cell rows were moved by the vertical wheel and by End/PageDown, with dimmed rows. So wrapping is no remedy as it stands. |
| P19 | **Theme.** With the default config, `getConfig().theme` is `"high-contrast"`, and `getThemeData("high-contrast")` is an object with `name, editor, ui, search, diagnostic, syntax, chrome, _key, _pack`. `editor.bg` is `[0,0,0]`. After `applyTheme("light")`, `getConfig().theme` is `"builtin://light"`, and `getThemeData("builtin://light")` is `null`. `getThemeData("light")` works (`editor.bg` `[255,255,255]`), and `getAllThemes()` is keyed by the bare names. **Overlay `bg:"editor.bg"`** renders exactly as no overlay does. On most rows that is the editor background. On the hidden cursor's row (the first row), the cells left of the image whose colour equals the editor background are drawn with the terminal's default background (SGR 49). That holds by theme key, by RGB and unstyled alike. A different RGB (250,250,250), or the key `"editor.current_line_bg"`, renders exactly. **The plan's assumption about `"editor.bg"` and `getThemeData` is partly contradicted:** `getThemeData` wants the bare name, and on the first row the key is drawn in the terminal's own background. The current-line highlight is not drawn on the image panel. |
| P20 | **Hidden tab.** With the group's tab hidden behind `a.txt`, `setPanelContent` returned `true`, and the new content was what showed on return. A terminal resize while hidden fired `viewport_changed` only for the host split. Returning by a tab click fired `buffer_activated` for `panels.img` (path `""`), not for the file. The image split's `viewport_changed` then followed, at the new size (159×40). `getViewport()` at that `buffer_activated` read 160×45. So panel updates and events behave as the plan assumed across a hidden tab. |
| P21 | **Kill.** A directly spawned `sleep 37`, and `ffmpeg … -f lavfi -i nullsrc -f null -`, were gone (`pgrep`) after `kill()`. `kill()` returned `true`, and the awaited result was `{"stdout":"","stderr":"","exit_code":-1}`, 110–130 ms after the kill. `sh script` running `sleep 38 \| cat` returned `true` from `kill()`, but its `sleep` stayed alive and the awaited result did not arrive until that `sleep` was killed by hand. So `kill()` reaches a direct child only, as the plan assumed. |
| P22 | **sips.** A plain `-s format bmp` orients: the Orientation=6 JPEG gives 3000×4000. It takes 116 ms, and the BMP is 36,000,054 bytes. BMPs are top-down. RGB, greyscale and GIF give 24-bit BMPs; RGBA PNG, WebP and the palette PNG give 32-bit `BI_BITFIELDS` (124-byte header). `-z H W` resamples to exactly W×H. **`-c h w --cropOffset y x`** is exact, except that `0 0` gives a centred crop. **Contradicting the plan's workaround (an origin flip):** with `x = 0`, a crop that reaches the bottom edge (`y + h = H`) is ignored, and the output is the whole image. So the plan's origin flip (`-f vertical`, then a crop at `H−h, 0`) fails. `(0, W−w)` and `(H−h, W−w)` work, so a horizontal flip avoids both cases while `w < W`. At full width (`w = W`) neither the top nor the bottom band can be cut by any flip. A 1-pixel `-p H+2 W+2` pad pass, followed by a crop at `(y+1, x+1)`, gave the right pixels in every case tried. **Per view on the 12 MP JPEG, base64 included:** fit (`-z 110 83`) 196 ms; 6.25% (`-z`, then crop) 200 ms; 100% (crop) 162 ms; 100% at the origin with a flip pass 320 ms; with the pad pass 281 ms. |
| P23 | **ImageMagick.** `convert` (IM6) and `magick` (IM7) behave alike. `'F[0]' -auto-orient -format '%w %h' info:` gives `3000 4000` for the Orientation=6 JPEG. A crop with `+repage` matched ffmpeg's pixels exactly for PNG, GIF frame 0 and RGBA PNG, and within a few levels for the JPEG (a different IDCT). `-filter Box -resize WxH!` averages. `-type TrueColorAlpha -depth 8 pam:` gives `RGB_ALPHA`, DEPTH 4, for every input on IM6. On IM7 a greyscale PNG still comes out `GRAYSCALE_ALPHA`, DEPTH 2. The JPEG's PAM header carries a comment line (`#Lavc62.28.100`, from its COM marker) before `WIDTH`. The size query takes 116–127 ms and a fit render 143–177 ms, in the VM. **Linux `base64 < file`** (coreutils 9.1 and 9.7) wraps at 76 characters. The plan's ImageMagick commands and its `base64 < file` read hold, provided the PAM reader skips `#` lines and takes DEPTH 1–4. |
| P24 | **A pinned image panel** (the user's amendment to P18). Same harness as P17–P21. The probe calls `createVirtualBuffer({hiddenFromTabs:true, scrollable:false, readOnly, editingDisabled, showLineNumbers:false, showCursors:false, highlightCurrentLine:false, mode})`, then `createBufferGroup` with the image leaf `{type:"scrollable", id:"img", bufferId}` and `{inTabOf: fileId}`. **What holds:** <br>- The file stays the active buffer after the create, which took 99 ms. The group lands in the file's tab: the P17 test gives `[0]`, and the tab bar shows only `a.txt ×  grad.png [BIN] ×`. <br>- The image split's `viewport_changed` arrives at 200×55, one column wider than a group-owned panel, with no scrollbar column. <br>- `setPanelContent(group, "img", …)` and `setVirtualBufferContent` both draw 55×200 byte-unit overlays exactly (0 of 11,000 mismatches). Mode keys reach the plugin. <br>- Horizontal wheel, Shift+wheel, vertical wheel, a click on the image or the header, and `x`/End/PageDown/Ctrl+End changed no cell. <br>**What fails: the byte flash.** Screens were sampled at about 180 a second while opening `grad.png` from `a.txt`, three runs each: <br>- With a group-owned panel, the bytes showed for 48–55 ms, then a blank frame, then the header 72–79 ms after the bytes first appeared. <br>- With the pinned panel, the bytes showed for 81–86 ms, the extra time being the virtual buffer's round trip. That is past R1's 50 ms. <br>The close paths were not tested further. By the amendment's rule the plugin keeps the group-owned panel, and A8 drops Shift+wheel. |
| P25 | **Found while building** (2026-11-25, same tools). <br>- **ffmpeg's `crop` is not exact on 4:2:0 input** (contradicting the plan, which took it to be exact). `crop=3:3:1001:701` of the 4000×3000 JPEG gave 2×2 pixels; `crop=3:3:1001:701:exact=1` gave 3×3, the same as cropping after `format=rgba`. The plugin passes `exact=1`. <br>- **sips writes palette PNGs with a small palette as raw pixels with no BMP header.** A 64×48 PNG with a 4-colour palette, from Python and from ffmpeg's `palettegen=max_colors=4`, gave 9,216 bytes (64·48·3) starting `00 00`. sips cannot read that file back. A 64-colour palette, GIFs, greyscale and RGBA are fine. With sips the plugin then shows the bytes, with "sips gave no image size". <br>- **A click moves the image panel's hidden cursor (P13). When the panel then shrinks, the host scrolls to keep that cursor visible.** After a click on row 58 (cursor at line 53) and a resize from 200×60 to 160×45, `getViewport()` read `topLine` 18 and `leftColumn` 221, and the new frame, exactly the panel's size, was drawn off-screen. With the cursor first put back by `setBufferCursor(panels.img, 0)`, the view stayed at 0,0 through the resize. The same start-up click had already left `leftColumn` at 1. <br>**Now handled.** The plugin calls `setBufferCursor(panels.img, 0)` in two places, both gated on the active window: on a `mouse_click` in the image panel, and on the image split's `viewport_changed` with a new size. <br>- With only the `viewport_changed` reset, a click and then a shrink to 160×45 ended at `topLine` 0 and `leftColumn` 0. <br>- With the `mouse_click` reset as well, the cursor stays at byte 0 after a click, `leftColumn` stays 0, and a click changes no cell. <br>- A9 then held after clicks on the image, at fit and at 400% (the spec's A9, re-run 2026-11-25). |
| P26 | **Typing latency with P3's method,** re-measured for A12. P3's method: send one key with `tmux send-keys`, then poll `tmux capture-pane` in a zsh `$EPOCHREALTIME` loop until it changes. <br>- **Layout.** 200×60, a vertical split, `big.jpg` at 50% on the left and `notes.txt` on the right. The typed letter goes at the end of the text's line 1. <br>- **What is polled.** During a redraw the image changes the pane too, so besides P3's whole-pane coloured hash, the typed line of the text split was polled alone. <br>- **15 samples each:** <br>  - no redraw, whole pane (exactly P3's `lat.sh`): 29–58 ms, median 37; <br>  - no redraw, the typed line only: 26–53 ms, median 33; <br>  - during five `→` 30 ms apart: 20–38 ms, median 31; <br>  - during a `+`: 35–46 ms, median 40. <br>- **The redraw was in flight.** In a timed run the letter showed 104–109 ms after the key, and the image changed at about 272 ms. <br>- **Verdict.** A redraw adds no real delay over today's no-redraw figures. Every figure, the no-redraw ones included, is above P3's 21–30 ms on this machine today. |
| P27 | **Tool edge cases for the code review** (2026-11-25; ffmpeg 8.1 on the host, IM 6.9.11-60 in `debian:bookworm-slim`, IM 7.1.1-43 in `debian:trixie-slim`). <br>**A `%` in a path, with ffmpeg.** Every format opens `frame%03d.<ext>` as the literal file when no file matches the pattern. With a file that does match beside it, ffmpeg opens that file instead: `img%d.png` gave `img1.png`'s 16×16, and `j%d.jpg` gave `j1.jpg`'s 300×400. <br>- `-pattern_type none` alone breaks inputs that image2 does not demux. `quadrants.png`, `quad.gif`, `pic.webp` and `quad.bmp` all gave "Error opening input file", with or without a `%`. <br>- `-f image2 -pattern_type none` read the literal file for PNG, JPEG, WebP, BMP and TIFF, the pattern traps included. EXIF orientation still applies: `o%d.jpg` gave 300×400. <br>- That fails for GIF ("Error opening output file"). `-f gif` reads a `%` GIF literally, with frame 1 (red). <br>**A `%` in a path, with ImageMagick** (6 and 7 alike). With `[0]`, a `%` is a format escape: `frame%03d.png[0]` looked for `frame000.png`. Doubling each `%` opened the literal file for PNG, JPEG, GIF, WebP and BMP, the traps included, and `p100%%.png[0]` opened `p100%.png`. <br>**Page offset.** A PNG written with `-page +10+5` (page `400x300+10+5`): `'off.png[0]' -auto-orient -crop 4x4+0+0 +repage` warns "geometry does not contain image" and gives a transparent pixel, on IM6 and IM7. With `+repage` before `-auto-orient` it gives red (255,0,0). `o6.jpg` still orients with `+repage` first (300×400). <br>**ffmpeg size probe on a file it opens but cannot decode.** A GIF cut to its first 30 bytes exits 69. Its stderr starts with the `Input #0, gif` header and the stream lines; the first tagged line is `[vist#0:0/gif @ …] [dec:gif @ …] Error submitting packet to decoder: Invalid data found when processing input`. A PNG or JPEG cut short still decodes (exit 0) or fails before the header. Recorded as `tests/fixtures/truncated.showinfo.txt`. <br>**A spawn refused by Blocked trust** (live, Fresh 0.5.9). `spawnHostProcess("rm", ["-f", f])` returned `{"stdout":"","stderr":"workspace trust is set to Blocked — no processes may run","exit_code":-1}`, and `f` was still there. The same call after trusting the folder returned `exit_code` 0 and removed it. With a render hanging when trust was set to Blocked, the deadline's `rm` was refused: the plugin logged "1 temp file(s) kept for later", and the file went as soon as trust was restored (`trust_changed`). |
| P28 | **ImageMagick's coder from the extension** (2026-11-25, ImageMagick 7.1.2-36 from Homebrew on the host, the plugin's own argv through Fresh with only `magick` on PATH). <br>- With a bare name, ImageMagick picks the coder from the file's first bytes: the plugin as it was showed a JPEG named `mis.png` as a 64×48 image, and PPM data named `ppm.png` as a 40×20 one. MagickCore's `SetImageInfo` checks those bytes only when no known `format:` prefix was given, and upper-cases the name. <br>- With the extension's coder in front (`png:`, `jpeg:`, `gif:`, `webp:`, `tiff:`, `bmp:`), both disguised files fail with `magick: improper image header`, and the plugin shows their bytes. <br>- With the prefix, every real test image still opens and draws: `quadrants.png`, `alpha.png`, `grey.png`, `anim.gif` frame 0, `pic.webp` (255,128,0), `quad.bmp`, a TIFF, `100%.png` (as `png:…100%%.png[0]`), and `o6.jpg` at 300×400, blue left and red right. |
| P29 | **ffmpeg 9.1** (2026-11-25, Homebrew's ffmpeg 9.1, which replaced the 8.1 build). P27's ffmpeg cases, re-run with the plugin's size-probe argv: <br>- A `%` path that matches no file opens the literal file for PNG, JPEG, GIF, WebP, BMP and TIFF. With a matching file beside it, `img%d.png` still gives `img1.png`'s 16×16, and `j%d.jpg` gives `j1.jpg`'s 300×400. <br>- `-pattern_type none` alone, on a name without a `%`, still fails for PNG, GIF, WebP and BMP ("Option pattern_type not found", exit 8). A name with a `%` goes to image2 by default, so there it works for PNG, JPEG, WebP, BMP and TIFF, and only GIF fails. P27 recorded those as failing with a `%` too; 8.1 is gone, so that can no longer be re-run. <br>- `-f image2 -pattern_type none` reads the literal file for PNG, JPEG, WebP, BMP and TIFF, the traps included. `o%d.jpg` still gives 300×400. <br>- **Changed:** forced image2 now reads a `%` GIF (400×300), which failed on 8.1. `-f gif` still reads it literally, frame 1 red. The plugin keeps `-f gif`, which works on both. <br>- The truncated GIF still exits 69, with the `Input #0, gif` header first and the same first tagged line. The size probe's showinfo line still carries the oriented ` s:WxH` (`o6.jpg` 300×400). <br>**Fixtures re-recorded** with `record.sh`. Only the four `*.showinfo.txt` changed: the encoder is `Lavc63.24.100` / `Lavf63.16.100`, and the later "Task finished with error…" lines are reworded. Every ffmpeg PAM and sips BMP fixture came out byte-identical, and a second run changed nothing. |
| P30 | **ffmpeg limited to the extension's demuxers and decoders** (2026-11-25, a later code review; ffmpeg 9.1 on the host, and Debian's 5.1.9 in `debian:bookworm-slim` and 7.1.5 in `debian:trixie-slim` on colima; the images from `tests/live/images.sh`, with the plugin's argv). <br>- **Without limits the content chooses**, as P28 found for ImageMagick. ffmpeg probes the demuxer from the file's first bytes, and the decoder follows. JPEG data named `mis.png` decoded through `image2` as a JPEG, and PPM data named `ppm.png` through `ppm_pipe`. On 9.1, BMP, GIF, TIFF and WebP data named `.png`, PNG data named `.jpg` or `.gif`, and JPEG data named `.bmp`, `.tif` or `.webp` all decoded as what they hold. SVG data named `.png` went to `svg_pipe`, and failed only because this build has no SVG decoder. <br>- **Forcing `-f image2 -pattern_type none` loses animated WebP** on 9.1: it fails with `skipping unsupported chunk: ANIM`, where probing picks `webp_anim` and decodes frame 1. <br>- **`-format_whitelist` and `-codec_whitelist`** with the extension's own demuxers and decoders (`lib/tools.ts`) keep the probing. On 9.1 every real image gave the same size and the same PAM bytes as without them: PNG (palette, grey, alpha, and an APNG at frame 1), JPEG and `.jpeg` (the Orientation=6 one still 300×400), GIF frame 1, BMP, still and animated WebP (frame 1), TIFF, and upper-case names. A 12 MP JPEG render took 30–37 ms either way. <br>- **Every misnamed file fails.** When image2 takes it by its extension, the error is `[mjpeg @ …] Codec (mjpeg) not on whitelist 'png,apng'`; when probing picks another demuxer, it is `[in#0 @ …] Format not on whitelist 'png_pipe,apng,image2'` (`[ppm_pipe @ …]` on 5.1 and 7.1). Both come before the generic errors they cause, such as `Error opening input: Invalid argument`, so the plugin takes the whitelist line as the reason. Recorded as `tests/fixtures/mis.showinfo.txt` and `ppm.showinfo.txt`. <br>- **5.1 and 7.1** gave the same as 9.1 for `quadrants.png`, `o6.jpg`, `anim.gif`, `quad.bmp`, `pic.webp`, `anim.png` and `alpha.png`, sizes and pixels alike, and refused the misnamed files the same way. Names they lack (`webp_anim`, `jpeg_mpf`) are harmless. Neither decodes animated WebP, with or without the limits. <br>- **In Fresh** (the `run-image-viewer` harness), `mis.png` and `ppm.png` show their bytes with the whitelist line in the status bar. `anim.png` and `animw.webp` show frame 1, red and orange. <br>- **JPEG-LS.** A `.jpg` holding JPEG-LS probes as `jpegls_pipe` and decodes with `jpegls`, so both are in the JPEG limits; a 320×240 one gives the same pixels as without them. <br>- **A `%` in the name** still forces `-f image2 -pattern_type none` (P27), which loses animated WebP: on 9.1 `a%d.webp`, a copy of `animw.webp`, fails with `skipping unsupported chunk: ANIM`, while a still WebP named `p%d.webp` opens. <br>- **sips cannot be limited.** It converts `mis.png` and `ppm.png` by their content, 400×300 each. |
| P31 | **A directory of the run's own, from the editor** (2026-11-25, the same review; the v0.5.9 source and the `run-image-viewer` harness, `HOME=/tmp/iv-drive/home`). <br>- **Why.** The plugin wrote its files straight into the shared temp dir, under names another local user could guess (a per-load token that `ps` shows, and a counter). On Linux they could plant a symlink at the next name, and `ffmpeg -y` or ImageMagick's `pam:` would write through it. <br>- **`scratchCreate(label)`** (DTS 6104-6122; `fe/services/plugins/owned_store.rs:126-240`) makes `<config dir>/.staging/<label>-<pid>-<n>-<nanos>` with `create_dir`, which fails rather than reuse an existing name. The config dir is `~/.config/fresh`, or `$XDG_CONFIG_HOME/fresh`. `scratchDiscard` removes the directory inside the editor with `remove_dir_all`, which unlinks a symlink rather than following it. No process runs, so workspace trust cannot refuse it. The token is dropped before the removal, so a directory that fails to go stays until the age sweep: every `scratchCreate` removes staging directories older than 24 h that no live token names. The calls are synchronous, and one store serves every plugin. Built-in plugins use it as a temp directory too (`EP/audit_mode.ts:4089-4113`, `EP/orchestrator.ts:9726-9739`). <br>- **Live.** A zoom on `big.jpg` wrote `.staging/image-viewer-<pid>-3-<nanos>/0.pam`, and both were gone once it was drawn. The editor makes them with the umask's modes: `.staging` and the run's directory were `drwxr-xr-x`, and the file `-rw-r--r--`. No one but the user can write there, so the symlink attack is closed. But on a Mac whose home directory admits its group (`drwxr-x---`, group `staff`), the group could read a crop while it exists, also of an image in Documents, Desktop, Downloads or Pictures, which macOS keeps 0700, as it keeps `$TMPDIR`. <br>- **Made private.** So the plugin runs `chmod 700` on `.staging`, the directory holding every run's, before any tool writes there: once a load, and on every run until it has worked. One a run would be too dear: inside Fresh a `spawnHostProcess` round trip took 30–153 ms (median 76, 20 runs of `chmod`), and with a `chmod` of the run's own directory first, zoom presses on `big.jpg` settled in up to 924 ms. Live, `.staging` was `drwx------` after the first render, and a `0.pam` only ever showed up inside it. A config dir that cannot be written gives no directory at all: every image then shows its bytes, with "cannot create a temporary directory". ImageMagick expands `%` in an output name, so the plugin doubles each `%` in that path. <br>- **A hang, with trust Blocked meanwhile.** An `ffmpeg` that runs the real size probe and hangs on the render: the run's directory was there during the hang. With trust then set to Blocked, the render was killed at 10 s, the process was gone, and the directory had gone within 1.5 s, with no `rm`. After `corrupt.png`, `mis.png` and every other open, `.staging` and `$TMPDIR` held nothing of the plugin's. <br>- **Cost.** `scratchCreate`, `scratchPath` and `scratchDiscard` together took 0.19–0.56 ms (median 0.32, 50 runs). Twelve zoom presses on `big.jpg` settled in 352–502 ms, against 300–511 ms for the code before this change, on the same machine the same day; with `.staging` made private once a load, 24 presses settled in 306–497 ms. |
| P32 | **An explorer preview opened into the view's empty panel** (2026-11-25, live verification with the `run-image-viewer` driver; the v0.5.9 source). <br>- **Seen.** Arrowing through images in the explorer at 40 ms a key, the preview tab the cursor stopped on often vanished: 11 of 15 runs, against 0 of 10 with the plugin not installed, with the same keys and cursor. At 100–400 ms a key none of 3 did, but at 200 ms a preview in mid-run still opened and closed within 10 ms. The log showed the new preview's buffer closed 1–10 ms after it opened, beside the previous preview's group, and the session's only error: `Failed to set panel 'img' content: BufferId(360) is not a plugin-composed buffer; its content is the file's`. <br>- **Why** (`fe/app/file_open_orchestrators.rs:1116-1124,1149,1489`, `fe/app/buffer_management.rs:309-323`, `fe/app/buffer_groups.rs:651`). The explorer's preview opens the file through `open_file_no_focus_inner(…, allow_replace_empty = true)`. When the active buffer is pristine (`is_pristine_scratch`: empty, unmodified, no path), that buffer's id is reused for the file. While a group shows, the active buffer is its focused panel, the image panel (P17), and that panel is empty from the create until the first render paints it, 100–300 ms later. A preview in that window loads the file into the panel. `preview_file` then closes the previous preview, whose group closes its panel buffers, and with them the file. <br>- **So** the plugin writes one blank cell into the image panel in the same turn as the create resolves, before it awaits anything. <br>- **That narrows it, and does not close it.** The editor handles a command a plugin sends from a callback on its next pass, and a key can come first: once, the group was created at .675, the next key opened `quad.jpg` at .680 into the still-empty panel, and the placeholder write failed at .681 with the error above. With the write, 21 of 21 bursts (15 of 4 down and 2 up, 6 of 19 down and 6 up, at 40 ms a key) left the preview the cursor stopped on, against 11 of 15 failing before. Over those runs' 250 opens, 2 previews in mid-burst still closed with the group (about 5 ms of exposure each, against 100–300 ms). |
| P33 | **A fringe at ffmpeg's transparent edges** (2026-11-25, live verification; Homebrew's ffmpeg 9.1). <br>- **Seen.** `alpha.png` (opaque magenta, then fully transparent pixels whose colour is green) at fit in a 199-column area: the boundary column drew (64,64,64) with ffmpeg, and (128,0,128) with sips and with ImageMagick. ffmpeg's own 200→199 `scale=…:flags=area` gives `(128,127,128, a=128)` there: swscale averages colour and alpha apart, so the hidden green comes in. <br>- **The chain.** `format=rgba,premultiply=inplace=1,scale…,unpremultiply=inplace=1` fixes the edge but turns opaque 255s into 254s: 8-bit premultiplying rounds. `format=gbrap16le,premultiply=inplace=1,scale…,unpremultiply=inplace=1,format=rgba` gives opaque `(255,0,255,255)` and the edge `(255,0,255, a=128)`, exact. <br>- **Cost,** best of 3 at fit for 12 MP: no change on a PNG (99 ms both), and 46 → 81 ms on a JPEG. JPEG has no alpha, so it keeps the plain chain. <br>- **Fixtures.** Re-recorded with the chain, `alpha-fit` gives its fully transparent pixels colour 0 instead of green, and `quadrants-fit` one pixel next to the centre mark 253 instead of 252 (255·99/100 = 252.45, rounded rather than cut). |

## 9. Constraints that shape any design

1. **Half blocks only.** There are no graphics protocols (§6), so an image is at most one pixel wide and two tall per cell. At 199×57 cells that is 199×114 pixels.
2. **Pixels come from an external program as text** (§5). Pure JS is feasible for PNG and GIF, too slow for JPEG, and always needs the whole file through `base64`.
3. **Show it in the file's tab** with `createBufferGroup(…, {inTabOf})`, using a header row plus the image (§2, P7). Do not use a single scrollable leaf.
4. **Open on `buffer_activated`**, which covers previews, and keep a per-buffer flag so that showing the bytes on purpose sticks (P7).
5. **Paint with byte-unit `inlineOverlays`.** Never use `segments`, `unit:"char"` or SGR text. `addOverlay` paints correctly but is lost on every content replace (P3, P8, P16).
6. **Never give the image panel more content than it shows.** Panning and zooming re-render what is visible, and the host has nothing to scroll. That also avoids the edge fade and a wheel or click shifting the view. Size from the image panel split's `viewport_changed`, or from `getViewport()` while that panel has focus (§4, P13, P14).
7. **Mouse-wheel panning is not reachable in 0.5.9.** Keys undo a host scroll, and a horizontal scroll sends no event (P13).
8. **Composite alpha over the theme background**, and show the first frame of an animation.
9. **Catch every rejection.** Every spawn can fail (tool missing, trust Blocked, timeout), and an unhandled rejection kills the plugin runtime.

## 10. Decisions for the user

**Chosen on 2026-11-25:**

- a new plugin;
- shown in the file's own tab (A);
- external converters only;
- zoom and pan added to the scope;
- zoom from fit to 1:1 and on to 8×;
- images shown automatically on every open.

Panning was chosen as keyboard and mouse wheel, on the condition that 0.5.9 could deliver the wheel. P13 shows it cannot, so the wheel is out of scope. The questions as asked:

1. **Approach:** a new plugin; a fork of `asukaminato0721/fresh-plugins#image-preview`; or `image-preview` as it is.
2. **Where it shows:** in the file's own tab (A); in place of the file's buffer (B); or in a tab of its own (C) (§2).
3. **Pixel sources:**
   - external converters only: ffmpeg, then ImageMagick, then sips on macOS, the first one found;
   - or the same plus a vendored pure-JS fallback for PNG and GIF (about 100 KB), so that a Linux machine with none of those tools still shows PNG and GIF.
4. **Scope.** Each of these widens the spec:
   - zoom and pan beyond fit-to-pane;
   - redrawing when the file changes on disk (`fileStat` has no mtime, so this needs `watchPath` or a size poll);
   - SSH windows;
   - SVG (it opens as text);
   - animation.

Defaults proposed unless overridden:

- **Plugin name.** The entry stem is `image_viewer` (no built-in uses it).
- **Formats.** PNG, JPEG, GIF (first frame), BMP and WebP, matched by extension; TIFF only through ffmpeg or ImageMagick.
- **Fit.** Fit to the pane, keeping the aspect ratio, and never upscaling past 1 source pixel per half-block.
- **Header row.** File name, pixel size, and the key hint.
- **Keys.** A key to show the bytes and one to show the image again.
- **Missing tools.** With no converter found, the bytes stay and the status line says which tools to install.
- **Remote windows.** Bind-mounted dev containers work as local. In SSH windows the bytes stay, with a status message.
- **Colour depth.** The README says to set `COLORTERM=truecolor` or `FRESH_COLOR_MODE=truecolor` for full colour (§3).
