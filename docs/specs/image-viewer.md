# Image viewer

After this ships, an image file opened in Fresh shows the picture in its own tab, in coloured character cells, instead of the file's bytes. The user can zoom and pan it from the keyboard, and switch the tab to the bytes and back.

The plugin is the second package in `deugene/fresh-plugins`. Investigation: [`docs/investigations/image-viewer.md`](../investigations/image-viewer.md), cited as INV §n, with probes P1–P33.

## Why

Opening a PNG or a JPEG in Fresh gives a read-only tab of escaped bytes (`<89>PNG<0D>…`), which tells the user nothing (INV P1). To see the picture they leave the editor.

The one third-party plugin that draws images, `image-preview`, has three problems (INV §1):
- it opens a second tab for every image;
- the bytes flash before the image appears;
- it needs chafa or ImageMagick, which neither macOS nor a default Linux install has.

## Current behaviour

- **Opening.** Fresh detects a binary file by its content and opens it read-only. It draws printable bytes as themselves and the rest as `<XX>`, and the status bar says "[binary file, read-only]" (INV §2).
- **Routes.** The explorer, Quick Open and the command line all lead there. An explorer single-click opens a preview tab, which Enter promotes (P1, P2).
- **SVG** opens as text.
- **Built-ins.** No built-in or registry plugin shows images, and upstream master has none either (INV §1).

## Requirements

**R1. The image opens in its own tab.** WHEN a file whose name ends in `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp` or `.webp` (any case) opens in a local window, its tab shall show the image instead of the bytes. This holds for every route: an explorer single-click or the explorer's arrow keys (preview), explorer Enter, Quick Open, the command line, or another plugin. `.tif` and `.tiff` are included WHERE the tool in use decodes them.
- The tab stays the file's own: the same name, close button and place. No other tab opens. A promoted preview keeps the image.
- The bytes shall not be drawn for longer than 50 ms before the view appears. Until the image is ready, the view says it is loading.

**R2. Fit.** At first the image shall be shown whole, at the largest size that fits the image area, keeping its aspect ratio. The image area is the tab's text area less the header (R3).
- Each character cell shows two pixels, one above the other.
- At fit the image is never enlarged: the scale is at most 100% (R4).
- The image is centred, and cells outside it show the editor background. Transparent pixels are blended over the editor background colour.
- A JPEG's EXIF orientation is applied. An animated image shows its first frame.

**R3. Header.** A one-row header above the image shall show, in order:
1. the file name;
2. the image's size in source pixels (`W×H`);
3. the zoom (`fit` or a percentage);
4. the view's keys.

A narrow pane cuts the end of the row.

**R4. Zoom.** In the image view, `+` and `=` shall zoom in, `-` shall zoom out, and `0` shall return to fit.
- **100%** is one source pixel per pixel drawn: one column wide, half a row tall.
- **The steps.** Zooming in doubles the scale, up to 800%. Zooming out halves it, down to fit. Both stop at 100% on the way. `+` at 800% and `-` at fit change nothing.
- **Above 100%** each source pixel is a solid block of one colour, with no smoothing.
- **The centre stays put.** The source point at the centre of the view stays at the centre, as far as the image's edges allow.

**R5. Pan.** WHILE the image is wider or taller than the image area, the arrows and `h j k l` shall move the view across it.
- Each press moves a quarter of the area's width or height, at least one cell, and stops at the image's edge.
- Along a direction in which the image fits, it stays centred.
- Only R4–R6 move the image. A mouse click, the vertical mouse wheel and any other key leave it in place. The horizontal wheel and Shift+wheel may slide the view sideways until the next key (P18, P24).

**R6. Resize.** WHEN the image area changes size, the view shall redraw for the new area within 1 s. Causes include a terminal resize, the explorer shown or hidden, and a split created, closed or dragged.
- At fit, the image fits the new area.
- At any other zoom, the view keeps the scale and the source point at the centre.

**R7. Bytes and back.** `b` in the image view shall switch that tab to Fresh's own byte view.
- A palette command shall switch the active tab back to the image, at fit. It is listed only while the active tab is an image file showing its bytes.
- The choice holds for that tab, also across tab switches, until it is switched back or the tab closes.
- A file opened again after its tab closed shows the image.

**R8. Closing.** Each of these shall close the tab:
- Fresh's close-tab key (Alt+W in the macOS keymap, P15);
- the tab's ×;
- `q` in the image view.

No buffer the view opened shall remain afterwards, and no tool it started shall keep running.

**R9. Speed.** The reference is this machine with ffmpeg found, and the probes' 4000×3000, 5 MB JPEG.
- The image shall show within 1 s of its tab appearing.
- Each zoom or pan key's result shall show within 500 ms.
- Presses faster than the redraws shall end, within 1 s of the last, on the view the last press asks for.
- Typing in another split during a redraw shall stay as responsive as with no view open.

**R10. Tools.** The plugin shall get pixels only from an image tool already installed, the first found in the order in Decisions. It shall ship no image decoder and download nothing.
- IF no tool is found, THEN the tab shall show its bytes, and a status message shall name the tools to install.

**R11. Failures.**
- IF the tool fails on an image (a corrupt file, a format it cannot decode, workspace trust set to Blocked) or has not finished within 10 s, THEN the tab shall show its bytes, with a one-line status message giving the reason.
- IF the window is an SSH remote window, THEN the tab shall show its bytes, with a status message that says so.
- Afterwards the plugin shall keep working for other images, show no dialog, and leave no file of its own behind.
- A bind-mounted dev container counts as local, because its files are on this computer (INV §7).

**R12. Package.** The plugin shall install with Package: Install from URL, from `https://github.com/deugene/fresh-plugins#image-viewer` and from a local checkout. It shall also be listed in the root `plugins.json`, keyed by its manifest name, so it installs from Package: Packages once `https://github.com/deugene/fresh-plugins` is a package source. After a restart, R1 holds.
- Its README shall give:
  - the tools it uses and how to install one;
  - the keys;
  - how to get full colour (`COLORTERM=truecolor` or `FRESH_COLOR_MODE=truecolor`, INV §3);
  - its limits: half-block resolution, keyboard-only panning, the first frame only.
- The root README's table shall list it.

## Out of scope

- **Panning with the mouse.** In 0.5.9 a key undoes the host's wheel scroll, and a horizontal scroll sends no event (P13).
- **Changes after the image is shown.** Reloading when the file changes on disk, and recolouring after a theme change before the next redraw.
- **Remote and volume workspaces.** SSH windows, and dev containers whose workspace is a volume.
- **Other formats.**
  - SVG, which stays text.
  - Animation, and TIFF pages after the first.
  - HEIC, AVIF and camera RAW, unless the tool happens to decode them.
- **Terminal graphics protocols** (kitty, iTerm2, sixel): 0.5.9 gives plugins no way to send them (INV §6).
- **Acting on an image.** Editing, converting, saving, copying to the clipboard, or opening it in another app.
- **Remembering the view.** The zoom or position across closing the tab or restarting.
- **Settings.** Choosing the tool, turning the viewer off, and rebinding keys beyond what Fresh offers.
- **Other cases.**
  - One image shown in two splits at once.
  - Coexisting with `image-preview`.
  - Translations.
  - Fonts whose cells are not twice as tall as wide.
  - Publishing to the official plugin registry, and CI.

## Constraints

- **Fresh 0.5.9.** Only APIs declared in its plugin type file. The name must not be a built-in plugin's. The directory must work on its own, since installing from `#<dir>` copies only it (root `CLAUDE.md`).
- **No unhandled promise rejections.** One kills the plugin runtime.
- **The bytes always open first.** `before_file_open` never fires, and `after_file_open` cannot cancel. The view must cover the byte buffer rather than prevent it (INV §2).
- **Resolution.** Half blocks are the only way to draw. That is at most one pixel per column and two per row (INV §3, §6).
- **No binary reads.** A plugin cannot read a binary file, and process output reaches it only as text. So pixels come from a tool, encoded as text (INV §5).
- **Colour depth.** Fresh draws in 256 colours unless it detects or is told truecolor, and a plugin cannot ask which (INV §3).
- **Workspace trust.** Blocked refuses every process. Restricted allows a tool named without a path (INV §7).
- **Fresh's keys keep working.** The view takes only the keys R4, R5, R7 and R8 name (P13).
- **The host scrolls content larger than its panel**, on a wheel turn or a click, and the plugin cannot hold that scroll (P13). R5's last point depends on never giving it that.

## Acceptance criteria

These are checked live in Fresh 0.5.9 under an isolated `HOME` in tmux (INV §8 harness) unless marked "unit". Cell colours are read with `tmux capture-pane -e`.

Test images:
- `quadrants.png`, 400×300: red, green, blue and white quarters, with a black 2×2 centre mark;
- an RGBA PNG with a fully transparent region;
- a JPEG with EXIF Orientation=6;
- an animated GIF;
- a 16×16 PNG;
- the probes' 4000×3000 JPEG;
- `corrupt.png`, a renamed text file.

**A1.** (R1) Open `quadrants.png` by explorer single-click, explorer Enter, Quick Open and the command line.
- Each time there is one tab for the file, showing the image.
- Enter on the preview keeps the image, in one tab.
- Arrowing through the images in the explorer, 40 ms a key, leaves the preview of the file the cursor stops on, showing the image (INV §8 P32).

**A2.** (R1) Sample frames every 10 ms from the open. No run of more than 5 frames shows `<89>PNG`, and the loading text shows before the image.

**A3.** (R1, R10)
- With ffmpeg, PNG, JPEG, GIF, BMP and WebP each open as images.
- On macOS with only sips found, the same holds.
- `QUADRANTS.PNG` opens as an image.
- A `.txt` and an `.svg` open exactly as before.

**A4.** (R2) `quadrants.png` in a 199×55 area:
- It is centred, and its aspect ratio is within one cell of exact.
- The top-left cell's upper half is red, and the bottom-right cell's lower half is white.

The other test images at fit:
- the 16×16 PNG spans 16 columns × 8 rows;
- the transparent region has the editor background colour, and the edge column is the opaque colour blended over it, with none of the transparent pixels' own colour (INV §8 P33);
- the Orientation=6 JPEG is taller than wide;
- the GIF shows frame 1.

**A5.** (R3)
- At fit the header reads, in order: `quadrants.png`, `400×300`, `fit`, the keys.
- After `+` it shows the new percentage.
- In a 40-column pane the name and size still show.

**A6.** (R4) On the 4000×3000 JPEG in a 199×55 area:
- `+` goes through doubling percentages, then 100%, 200%, 400% and 800%. Another `+` changes nothing.
- `-` returns to fit by the same stops, and `0` at 400% goes straight to fit.
- The 16×16 PNG at 800% draws each source pixel as an 8×4-cell block of one colour.

**A7.** (R4) After each `+` from fit to 800% on `quadrants.png`, the centre mark is within one cell of the area's centre.

**A8.** (R5) `quadrants.png` at 400%:
- `→` and `l` move by a quarter of the area's width. Repeated `→` stops with the image's last column in the area's last column. The other three directions behave the same, by arrow and by letter.
- At fit, the arrows change no cell.
- A click on the image, wheel up and down, and `x` change no cell.

**A9.** (R6) Resize the window from 200×60 to 160×45, then toggle the explorer. Within 1 s of each change:
- at fit, the image fits the new area;
- at 400%, the scale and the centre mark's source point are kept.

**A10.** (R7)
- `b` gives the tab `<89>PNG…`, in one tab, and still after switching away and back.
- The palette lists the Show Image command; running it shows the image at fit.
- The command is not listed on a text file's tab, nor on an image showing its image.
- Close the tab and open the file again: the image shows.

**A11.** (R8) Alt+W, the ×, and `q` each close the tab.
- The log shows `buffer_group_closed`.
- A probe's buffer listing has nothing left of the view.
- Opening the file again shows the image.
- Closed while a tool hangs, the tab leaves no tool running 1 s later.

**A12.** (R9) This machine, ffmpeg found:
- The 4000×3000 JPEG shows within 1 s of its tab.
- Each `+` and `→` result shows within 500 ms.
- Five `→` sent within 100 ms end, within 1 s, on the same cells as five sent 1 s apart.
- Keystroke latency in a text split during a redraw is no worse than with no redraw, both measured by P3's method (P26).

**A13.** (R10) With `PATH` holding `sh`, `base64` and `chmod` but no ffmpeg, ImageMagick or sips:
- `quadrants.png` shows its bytes, and a status message names the tools. No dialog appears.
- With the tools back, a later open shows the image without a restart.

**A14.** (R11) Each of these shows the bytes and a one-line reason:
- `corrupt.png`;
- trust set to Blocked;
- a fake `ffmpeg` that sleeps 30 s, put first on `PATH`. Its message comes at about 10 s, and no `ffmpeg` is left running;
- an SSH window (unit, faked).

After each, a valid image opens normally, and neither the temporary directory nor the editor's staging directory (`.staging` under its config dir) holds anything of the plugin's.

**A15.** (R12)
- `npm run check` exits 0.
- An install from the local checkout `#image-viewer` under an isolated `HOME`, followed by a restart, gives A1.
- With the repository as a package source, Package: Packages lists image-viewer once, and an Install from there, followed by a restart, gives A1.
- The README covers R12's topics, and the root table has the row.

## Decisions

"user" means the user chose it on 2026-11-25. "default" means it was proposed and accepted at spec approval, and "plan approval" that it was proposed in the implementation plan and accepted when the plan was approved, both on the same day.

| Decision | Why | Source |
|---|---|---|
| A new plugin, not `image-preview` forked or as is | Its two tabs, byte flash and tools are the problem | user |
| Shown in the file's own tab | The only way to one tab that stays the file's (INV §2, P7) | user |
| External tools only. The first found of ffmpeg, then ImageMagick (`magick`, or IM6 `convert`), then sips on macOS | JS decoding is too slow for JPEG in Fresh's runtime (INV §5). The maintainer prefers external programs (INV §1). sips ships with macOS | user (order: default) |
| Zoom from fit through 100% to 800% | Photos need 100%, icons and pixel art need more | user |
| Keyboard-only panning | Wheel panning was chosen on condition that 0.5.9 could deliver it; P13 shows it cannot | user |
| Automatic on every open, with no off switch | Viewing is why an image is opened; `b` gives the bytes | user |
| Keys `+`/`=`, `-`, `0`, the arrows, `h j k l`, `b`, `q` | Common viewer keys. `q` closes, as in Fresh's diff view. Each reached the plugin before Fresh's keymap (P13) | default |
| Back from the bytes by a palette command | The byte view is Fresh's buffer, where the plugin has no keys | default |
| Transparent pixels blended over the editor background, with no checkerboard | A checkerboard at two pixels per cell is noise | default |
| Fit never enlarges | A small image at 100% is as sharp as half blocks get, and `+` enlarges it | default |
| A pan step is a quarter of the area | It crosses an 800% image in a few presses and keeps context | default |
| A tool gets 10 s | A 12 MP JPEG takes 0.1–0.3 s (P10, P16) | default |
| Zoom stops: fit, then every 100%·2^k up to 800% (k ≤ 3) that is above fit. `+` goes to the smallest stop above the current scale, `-` to the largest below it | R4's doubling and halving, with fit as the floor. On the probes' 4000×3000 JPEG in a 199×55 area, fit is `min(1, 199/4000, 110/3000)` = 3.67%, so `+` goes 6.25, 12.5, 25, 50, 100, 200, 400, 800%. A 16×16 image fits at 100% and has 200, 400, 800% | plan approval |
| The image panel is pinned against the horizontal wheel: a virtual buffer created with `scrollable: false` and mounted in the group by `bufferId`, if probe P24 shows that it holds. If it does not, A8 drops Shift+wheel, and the horizontal wheel may slide the view until the next key. **Outcome:** P24 held against the wheel but lengthened the byte flash past R1's 50 ms, so the fallback was taken | A group panel scrolls sideways on Shift+wheel even when its content fits it exactly, and no event fires (P18) | user |
| sips crops after a 1-pixel pad pass, at `(y+1, x+1)` | sips centres a crop at `0 0`, and ignores one at column 0 that reaches the bottom edge. The pad was correct in every case tried (P22) | user |
| On the image panel's first row, a cell whose colour equals the editor background is drawn one unit off in one channel | On the hidden cursor's row such cells draw in the terminal's default background instead (P19) | user |
| ffmpeg may use only the extension's demuxers and decoders (`-format_whitelist`, `-codec_whitelist`), not a forced `-f image2` | Otherwise the file's content chooses among all of ffmpeg's demuxers and decoders, which P28 already stopped for ImageMagick. A forced `image2` would lose animated WebP on ffmpeg 9.1. A misnamed file then shows its bytes, except with sips, which cannot be limited (P30) | user |
| Each run that writes files gets a directory of its own from the editor's `scratchCreate`, removed with `scratchDiscard` when the run ends. The staging directory that holds them is made 0700 once a load | Names in the shared temp dir can be guessed, and another local user could plant a symlink there for a tool to write through. The staging directory is under the user's config dir, and its removal runs in the editor, where workspace trust cannot refuse it. Built-in plugins use it the same way. The editor makes it with the umask's modes, which on a Mac let the user's group read crops of private images; one `chmod` a run would add a spawn, 30–150 ms, to every redraw. A config dir that cannot be written leaves every image showing its bytes (P31) | user |
| The image panel gets one blank cell as soon as its group is up, before anything is awaited | An empty image panel is the active buffer while the group shows, and the editor reuses such a buffer for the next file it opens: an explorer preview would load into the panel and close with the group (INV §8 P32) | user |
| With ffmpeg, a format that can carry alpha is scaled premultiplied, in 16 bits (`format=gbrap16le,premultiply`, then `unpremultiply`); JPEG is not | Otherwise transparent pixels' hidden colour bleeds into a downscaled edge. 8-bit premultiplying turns opaque 255s into 254s. JPEG has no alpha, and the chain costs it 35 ms at 12 MP (INV §8 P33) | user |
| A view that ends (the tab closes, `b`, Show Image, a failure) kills its running step at once, as the deadline would | A tool otherwise ran on for up to 10 s after the tab closed | user |
