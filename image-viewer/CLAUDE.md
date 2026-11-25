# image-viewer

Spec: `docs/specs/image-viewer.md` (R*n*, A*n*). Investigation: `docs/investigations/image-viewer.md` (INV §*n*, P*n*). Cite only these.

The entry only wires the editor to `lib/`, whose modules never touch editor globals: put logic there and unit-test it. A newly used editor API has to be added to `tests/fake_editor.ts`. The fake's buffer-group behaviour follows INV §2, P7, P15 and §8 P17; keep it that way when the host changes. Fixtures are recorded by `tests/fixtures/record.sh`; re-run it rather than hand-editing them.

## Invariants the host forces

- **The view is a buffer group in the file's own tab** (`createBufferGroup(…, {inTabOf: file})`, INV §2, P7): a 1-row `fixed` header over a `scrollable` image panel, because a single scrollable leaf draws nothing.
  - Create it synchronously in `buffer_activated`, before anything is awaited (R1).
  - The group lands in the file's tab only while the file is the active split's buffer tab. So:
    - **pre-check:** the file is the active buffer;
    - **post-check:** the file's `getBufferInfo().splits` holds the split that was active when the create was sent. A group in a tab of its own leaves `[]` (INV §8 P17). Check against that split, not the one active when the create resolves, or a focus move in between closes a group that landed right.
  - The post-check reads the window's buffers, so it runs only while the tab's window is active.
  - A group that fails the post-check, or whose tab state was dropped meanwhile, is closed at once (INV §8 P17). Explorer Enter (activate 2, activate 3, close 2) relies on this.
  - **The image panel is never empty while its group is up (INV §8 P32).** It is the active buffer while the group shows, and the editor reuses an empty, pathless active buffer for the next file it opens: an explorer preview would load into the panel and close with the group. So `created()` writes one blank cell into it in the same turn, before anything is awaited, and nothing ever writes it empty. The editor handles that write on its next pass, so a key in the ~5 ms before it can still hit an empty panel: this narrows the race, and does not close it.
  - Detecting the tool and probing the size need no group, so they start right after the create is sent. The first render waits for both and for the group, and every step re-checks the tab's epoch, so a tab dropped mid-probe stops there and its run's directory goes (R11).
- **The image area comes only from the image split's `viewport_changed`**, and never a size with zero rows or columns. That event arrives on its own after every create. `getViewport()` right after the create reports the file's split or the whole screen (INV §8 P17).
- **The bytes stick (R7, INV §2).** `buffer_group_closed`, whoever closed the group (`b`, a failure, the host), keeps the state as `kind: "bytes"`. The host's `buffer_activated` for the file that follows must then be ignored. Only `buffer_closed` for the file, or Show Image, deletes the state.
  - Every way into the bytes goes through `toBytes`: `b`, a failure, a rejected create, a preflight, `buffer_group_closed`.
  - It says why, bumps the epoch, and drops the tab's queued operations except its status. It closes the group if one is up, and releases the canvas and the render loop, which Show Image rebuilds.
- **Windows (INV §2).**
  - Group and split ids are per window, so every lookup matches the window as well as the id. Buffer ids are global, but keying them by window too costs nothing; the fake numbers them per window, which is stricter than the host.
  - Groups, panels, status, contexts and the cursor reset act on the active window. They go through the window queue, one per kind per window; one that runs at once drops its stale queued twin.
  - A queued image operation holds the canvas, not the cells: it cuts and builds them for the area as it is when it runs.
  - A queued operation runs only while `activeWindow()` is still its window. The `active_window_changed` that drains a queue can arrive after the user has moved on.
  - Creates in flight are counted per window. `window_closed` forgets the window's tabs, queue, creates and waiting plans: a queued operation for a closed window would never run.
- **Processes (R8, R11, INV §7, §8 P21, P31).**
  - Each converter step is spawned directly, never under `sh -c`: `kill()` reaches only the direct child, and a child of a shell keeps the pipe open and hangs the reader.
  - One deadline promise per plan races every step. At the deadline the step is killed without being awaited, and the failure shows at once.
  - So does the tab's `stop` (R8). Every epoch bump goes through `endView`, which fires it: a view that ends (the tab closes, `b`, Show Image, a failure) kills its running step at once, through the same kill path as the deadline.
  - A run that writes files gets a directory of its own from `scratchCreate`, under the editor's config dir, never the shared temp dir: names there can be guessed, and a planted symlink would be written through. The plan asks for it through `dir()`, so a plan that writes nothing (detection, the ffmpeg and ImageMagick size probes) never makes one.
  - The editor makes these with the umask's modes, so before any tool writes, the runner `chmod 700`s the staging directory that holds them: once a load, and on every run until it has worked. Not the run's own directory each run: a spawn costs 30–150 ms in Fresh, and every redraw would pay it.
  - The last step only base64-encodes the output, and is never killed.
  - However the run ends (the read, a failure, a kill, an epoch change between steps), the runner's `finally` removes the directory with `scratchDiscard`, whatever the epoch. After a kill it waits up to 1 s for the killed step to exit, so it does not race a converter still writing. The removal runs in the editor, not as a process, so workspace trust cannot refuse it: never clean up with `rm`.
  - The host also gives `exit_code -1` for a step a signal ended, with whatever the tool wrote. So only a -1 with a reason in stderr is taken for a refusal; one with none says the tool was killed by a signal.
  - Workspace trust is checked against the active window. A spawn it refuses comes back `exit_code -1` and ran nothing (INV §8 P27). So a refused read step counts as not run. A plan step refused while another window is active says nothing about the tab's own window: the plan runs again, in a new directory, once that window is active. Only the refusal of a step spawned while the tab's window was active shows the bytes; the runner records that window at the spawn, not at the answer.
- **Tools (INV §8 P22, P23, P25, P27–P31, P33).**
  - ffmpeg's crop needs `exact=1`, or 4:2:0 input is cropped to even sizes and offsets.
  - ffmpeg scales a format that can carry alpha premultiplied, in 16 bits (`format=gbrap16le,premultiply=inplace=1,scale…,unpremultiply=inplace=1`, INV §8 P33): swscale averages colour and alpha apart, so transparent pixels' hidden colour bleeds into the edge, and 8-bit premultiplying turns opaque 255s into 254s. JPEG keeps the plain chain. `tests/fixtures/record.sh` mirrors it.
  - The content must not choose the decoder. A misnamed file then shows its bytes.
    - ffmpeg gets `-format_whitelist` and `-codec_whitelist` with the extension's own demuxers and decoders, `image2` always among the formats. Keep the probing inside them: a forced `-f image2` loses animated WebP on 9.1. Names a version lacks (`webp_anim` before 9.1) are harmless. The reason is the whitelist line, which `stepReason` puts before the generic errors it causes.
    - ImageMagick's input names the extension's coder (`png:`, `jpeg:`…). Without one it picks the coder from the file's first bytes, delegates included.
    - JPEG-LS in a `.jpg` has its own demuxer and decoder (`jpegls_pipe`, `jpegls`), so they are in the JPEG limits.
    - sips cannot be limited, and decodes by content.
  - A `%` in a path:
    - ffmpeg takes it as a sequence pattern and opens `frame1.png` for `frame%d.png`. Such a path also gets `-f image2 -pattern_type none`, or `-f gif` for a GIF, which image2 cannot read on ffmpeg 8.1 (9.1 can; `-f gif` works on both). Forced image2 loses animated WebP, a known limit for such a name.
    - `-pattern_type none` without `-f image2` breaks PNG, GIF, WebP and BMP inputs.
    - ImageMagick with a `[0]` scene expands `%` escapes, so each `%` becomes `%%`. It expands them in an output name too, so its `pam:` path doubles them as well.
  - ImageMagick crops relative to the page offset (a PNG's oFFs), so `+repage` comes before `-auto-orient` and `-crop`.
  - ImageMagick writes greyscale as `GRAYSCALE_ALPHA` despite `-type TrueColorAlpha`, and copies image comments of any length into the PAM header. So `parsePam` takes DEPTH 1–4, skips `#` lines, and has no header size limit.
  - ffmpeg's size probe runs at `-v info`, so its stderr starts with the `Input #0` header. The reason is the first tagged error line after it.
  - sips:
    - crops only after a 1-pixel pad pass, at `(y+1, x+1)`, because it centres a crop at `0 0` and ignores one at column 0 that reaches the bottom edge;
    - writes palette PNGs with few colours as headerless data, which fails as "no image size".
  - Linux `base64` wraps its output.
- **Never give the image panel more than it shows (INV §9.6, P18).**
  - Entries are at most rows × cols, with no `\n` after the last row, and no line wrap.
  - Even so, Shift+wheel and the horizontal wheel scroll the panel sideways until the next key, with no event (P18). The spec's A8 fallback accepts that.
- **The hidden cursor stays at byte 0 (INV §8 P25).** A click on the image moves the panel's hidden cursor, and with it the view (P13). When the panel then shrinks, the host scrolls it to keep that cursor visible, so the next frame lands off to one side.
  - The cursor is reset on a `mouse_click` in the image panel.
  - It is also reset on the image split's `viewport_changed` with a new size, before the re-cut frame and the next render.
  - Keep both: the click reset also stops the one-column shift a click alone caused.
- **The view's centre is stored as the user left it (R6).** Only `layout` clamps it, when drawing, so a grow and a shrink back give the same view. Zoom and pan start from the clamped centre on screen, so no press is spent pulling a stored centre back to an edge. A zero or non-finite size gives fit 100%, so the stop list always ends.
- **Painting (INV §3, P3, P19).**
  - Every image cell gets one byte-unit inline overlay. Padding gets one overlay per run, in the theme key `editor.bg`. A cell with image in one half only draws that half as the fg (`▀`, or `▄` for a lower half) over the padding's bg, never the canvas's stand-in colour.
  - On the first row, any colour equal to the editor background is drawn one unit off: there such cells otherwise come out in the terminal's default background.
  - Above 100% the vertical placement and phase are whole cells, so blocks start on a cell boundary.
  - The background RGB comes from `getThemeData`, for `getConfig().theme` resolved as the host's theme registry does: `builtin://` stripped, and a relative `.json` path (how a user theme is saved) turned into a `file://` key under `getThemesDir()`. A `.json` path or a `file://` value gets `~`, `$VAR` and `${VAR}` expanded first (`getEnv`), as the host's `expand_env_vars` does.
  - `editor.bg` can be an RGB, a colour name (taken at the host's RGB for it) or `{color, modifier}`. The name `Default` is the terminal's own background, whose RGB no plugin can read: blending is then over black, and the first row is not nudged.
  - It is read once per frame and carried on the canvas. Blending, the first-row nudge and a shrink's re-cut all use that one value.
- **Renders (R9).** One per tab at a time.
  - A key changes the view and the header at once, then requests a render.
  - A result that lands after newer presses is still painted, cut to the area at that moment, and then the latest view runs.
  - A panel that shrinks gets the last canvas re-cut at once.
- **No import cycles between modules, not even type-only ones.** Fresh's bundler reads every imported name, types included, as a value from the other module's object. In a cycle it orders the modules wrongly, and the plugin fails to load with `__mod_<name> is not initialized`. `fresh --check-plugin` still exits 0, so only a live load shows it. Shared types live in the module that the others import.
- **No rejections.** Every handler, command and async entry point goes through `guarded` or `guardedAsync`. Throw nothing synchronously inside an `async` function that is awaited later (git-sidebar's note on QuickJS).
