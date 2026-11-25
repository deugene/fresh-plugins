---
name: run-image-viewer
description: Run, launch, drive and screenshot the image-viewer plugin in a real Fresh editor, and run its checks. Use when asked to start or try image-viewer live, open an image in it, zoom or pan, show the bytes and Show Image again, check cell colours, time a redraw, try it with no image tool or a hanging one, read the plugin's log, or capture the screen.
---

image-viewer is a Fresh plugin, so "running it" means running Fresh with the package loaded. `.claude/skills/run-image-viewer/driver.mjs` starts Fresh in a detached tmux session, with an isolated `HOME` and socket dir, in a folder of test images. Each subcommand then sends one input or reads one thing back. Its header lists the subcommands and their flags.

All paths are relative to `image-viewer/`. It needs `fresh`, `tmux`, `node`, `python3` and `ffmpeg` on `PATH`, and no npm packages.

## Run (agent path)

```bash
D=.claude/skills/run-image-viewer/driver.mjs
node $D start notes.txt quadrants.png   # builds the images once, starts Fresh on them, prints the screen
node $D keys + + l                      # zoom twice, pan right
node $D cell 5 27 173                   # a cell's character and truecolor fg/bg, 1-based screen coordinates
node $D keys b                          # the bytes
node $D cmd "Image Viewer: Show Image"  # back, at fit
node $D eval "editor.openFile('/private/tmp/iv-drive/imgs/big.jpg', null, null); return true;"
node $D time key:+ --change             # ms to the first and last screen change
node $D log
node $D stop
```

- **Open the first file after another one** (`notes.txt` above). Closing the last tab shows the hidden token terminal, which then takes the keys.
- **The images** are in `/tmp/iv-drive/imgs`. The header of `tests/live/images.sh` lists them. `start` builds them only when they are missing, so after changing that script pass `--rebuild`.

**Running beside another driver, or your own tmux.** By default every driver shares `/tmp/iv-drive`, the session name `iv-drive` and the default tmux server, so a second one would stop and wipe the first. Give each its own, and export them so every call sees them:

```bash
export IV_DRIVE_DIR=/tmp/iv-mine IV_DRIVE_SESSION=iv-mine IV_DRIVE_SOCKET=iv-mine
node $D start notes.txt quadrants.png     # images, HOME and state under /tmp/iv-mine
tmux -L iv-mine capture-pane -t iv-mine -p   # raw tmux needs the socket too
```

Paths above under `/tmp/iv-drive` are then under `$IV_DRIVE_DIR`.

**Explorer previews while the image loads (A1, INV §8 P32).** Each arrow key in the explorer opens the next file as the preview, so fast arrows hit views still loading. The preview the cursor stops on must stay, showing its image:

```bash
node $D start --explorer notes.txt
node $D click --explorer alpha.png         # --explorer: never the tab bar
node $D keys Down Down Down Down Up Up --gap 40
sleep 3; node $D screen | sed -n 2p       # … anim.png (preview) [BIN] …
node $D log ' WARN | ERROR '              # nothing
```

**How long the bytes show while an image opens (A2), and when it is drawn.** Open it from Quick Open: `BSpace` turns the palette into file mode.

```bash
node $D keys C-p BSpace && node $D type quadrants.png
node $D time mark key:Enter --count '<89>PNG' --until 'quadrants\.png  400×300' --interval 10
```

**Typing latency (A12).** Use P3's method, recorded in INV §8 P26:
1. send one key with `tmux send-keys`;
2. poll `tmux capture-pane` in a zsh `$EPOCHREALTIME` loop until it changes. A script run by zsh needs `zmodload zsh/datetime` first, or `$EPOCHREALTIME` is empty and every time reads 0.

With `IV_DRIVE_SOCKET` set, both tmux calls take `-L "$IV_DRIVE_SOCKET"`.

While the image redraws, poll only the text split's line, because the image changes the pane too.

**No tool, or a hanging one (A13, A14).**

```bash
TP=$(bash tests/live/toolpath.sh /tmp/iv-drive/tp)       # sh, base64, chmod, rm and core tools; no image tool
node $D start --path "$TP" notes.txt                      # an image opens as its bytes, with the "no image tool" message
bash tests/live/toolpath.sh "$TP" --with ffmpeg           # tools back: the next open shows the image, no restart
mkdir -p /tmp/iv-drive/fake && ln -sf "$PWD/tests/live/fake-ffmpeg" /tmp/iv-drive/fake/ffmpeg
node $D start --path "/tmp/iv-drive/fake:$PATH" --env IV_FAKE_PIDS=/tmp/iv-drive/fake.pids notes.txt
# an image open times out at 10 s; then `ps -p $(cat /tmp/iv-drive/fake.pids)` finds nothing
ls -A /tmp/iv-drive/home/.config/fresh/.staging 2>/dev/null  # nothing: each run's directory goes when it ends, and the hung size probe made none (INV §8 P31)
```

`toolpath.sh … --with sips` gives a sips-only PATH. Each call sets the directory's image tools afresh, so a reused `/tmp/iv-drive/tp` has only the ones that call names.

**Trust.** Use the palette's "Workspace Trust…" dialog: `B` then Enter blocks, `T` then Enter trusts again.

## Run (human path)

Install from the checkout (**Package: Install from URL**, `/path/to/fresh-plugins#image-viewer`), restart Fresh, and open an image. See the root `CLAUDE.md`, "Trying a plugin in Fresh".

## Test

`npm run check`; read its exit code, not the bundle it prints. The tools test runs the planned ffmpeg and sips argv end to end when those tools are installed.

## Gotchas

- **Plain `fresh` leaves a daemon behind that your own editor can attach to.** So the driver runs `fresh --simple` with its own `XDG_RUNTIME_DIR`, and unsets `FRESH_SESSION` and `FRESH_CMD_TOKEN` (git-sidebar's run skill explains why).
- **`script run` and `command run` need a capability token.** The driver's `init.ts` mints one into a hidden terminal, `iv-driver-token`. Filter that buffer out when listing buffers.
  - That terminal takes the keyboard until a click lands on a pane, so `start` clicks the last text row.
  - That click lands on the image when one is open. The plugin puts the panel's hidden cursor back at byte 0 on every click and resize (INV §8 P25). `node $D eval 'return editor.getViewport()'` should read `topLine` 0 and `leftColumn` 0.
- **Splitting the image's tab** ("Split Vertical") gives a split that shows the image panel's own buffer, with line numbers. Open a file in it before typing there.
- **The palette** opens at the bottom of the screen, in `>command` mode.
- **The explorer's cursor opens a preview of each file it passes,** so arrowing past images opens and closes their views.
- **`click TEXT` takes the first match anywhere on screen,** tab bar included: once `quadrants.png (preview)` is a tab, `click quadrants.png` clicks the tab, which promotes it and moves the keyboard out of the explorer. Use `click --explorer`, or `--below REGEX`.
- **The workspace path is `/private/tmp/…` on macOS.** Use it in `openFile`.
- **Colours** are truecolor because the driver sets `COLORTERM=truecolor`. Without it, Fresh under tmux draws in 256 colours (INV §3).

## Troubleshooting

- **`driver: no /tmp/iv-drive/token.env: init.ts did not mint a token`**: the token terminal did not start. `node $D log iv-driver` shows why.
