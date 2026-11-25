# image-viewer

A [Fresh](https://github.com/sinelaw/fresh) plugin. An image file opened in Fresh shows the picture in its own tab, drawn in coloured character cells, instead of its bytes. You can zoom and pan from the keyboard, and switch the tab to its bytes and back.

- **Formats.** `.png`, `.jpg`/`.jpeg`, `.gif`, `.bmp` and `.webp`, in any case.
- **TIFF.** `.tif`/`.tiff` work where the tool decodes them.
- **SVG** stays text.

It works for every way of opening a file: the explorer (a preview, or Enter), Quick Open, the command line, or another plugin. The tab stays the file's own tab.

## Tools

The plugin decodes nothing itself. It asks the first of these it finds on `PATH` for the pixels, each time it opens an image:

1. `ffmpeg`;
2. ImageMagick, as `magick` (version 7) or `convert` (version 6);
3. `sips`, which comes with macOS.

With none of them installed, the tab shows its bytes and the status bar names the tools. To install one:

| System | Command |
|---|---|
| macOS | nothing needed (`sips`); or `brew install ffmpeg` |
| Debian, Ubuntu | `sudo apt install ffmpeg`, or `sudo apt install imagemagick` |
| Fedora | `sudo dnf install ffmpeg-free`, or `sudo dnf install ImageMagick` |
| Arch | `sudo pacman -S ffmpeg`, or `sudo pacman -S imagemagick` |

ffmpeg is the fastest. One view of a 12-megapixel JPEG takes about 0.3–0.45 s on an M-series Mac, with sips about the same.

## Install

With `https://github.com/deugene/fresh-plugins` added to **Settings → Packages → Sources** (see the [root README](../README.md#install)), run **Package: Packages**, select image-viewer and choose **Install**.

Or run **Package: Install from URL** with `https://github.com/deugene/fresh-plugins#image-viewer`, or a local checkout `/path/to/fresh-plugins#image-viewer`. Then restart Fresh.

## Keys

In the image's tab:

| Key | Does |
|---|---|
| `+` or `=` | zoom in: doubling, through 100%, up to 800% |
| `-` | zoom out, down to fit |
| `0` | fit |
| arrows, `h` `j` `k` `l` | pan by a quarter of the view, while the image is larger than it |
| `b` | show the file's bytes in this tab |
| `q` | close the tab |

To get the image back from the bytes, run **Image Viewer: Show Image** from the command palette. It is listed only while the active tab is an image file showing its bytes.

Fresh's own keys keep working, for example Alt+W to close the tab on macOS.

## Full colour

Fresh draws in 256 colours unless it knows the terminal does truecolor. A plugin cannot ask which mode it is in. For the image's real colours, start Fresh with `COLORTERM=truecolor`, or with `FRESH_COLOR_MODE=truecolor`. Under tmux in particular, Fresh does not detect truecolor unless one of these is set.

## Limits

- **Resolution.** Each character cell shows two pixels, one above the other, so a 200×60 terminal shows at most about 199×110 pixels at a time.
- **Panning is by keyboard only.** Fresh 0.5.9 gives plugins no way to follow the mouse wheel.
  - Shift+wheel and the horizontal wheel slide the view sideways until the next key.
- **Animations** show their first frame only. TIFFs show their first page. With ffmpeg, an animated WebP needs ffmpeg 9.1 or later, and one whose name holds a `%` shows its bytes.
- **Local files only.** In an SSH or Kubernetes window, and with workspace trust set to Blocked, the tab shows the bytes and says why.
- **The extension decides the format.** With ffmpeg or ImageMagick, a file whose content does not match its extension (a JPEG named `.png`) shows its bytes. sips reads it by its content.
- **sips quirks.** sips cannot read palette PNGs with very few colours, which then show their bytes.
- **No caching.** Each zoom or pan asks the tool again, about 0.1–0.45 s per view.
- **Slow images.** A tool that has not finished after 10 s is stopped, and the tab shows the bytes. Closing the tab stops it at once.
- **A writable config dir.** Each view's files go in a private directory under Fresh's config dir (`~/.config/fresh/.staging`, or `$XDG_CONFIG_HOME/fresh/.staging`), never the shared temp dir. The plugin makes `.staging` private with `chmod`, which must be on `PATH`. If that directory cannot be written, as with a read-only `~/.config/fresh`, every image shows its bytes, with "cannot create a temporary directory"; if it cannot be made private, every image shows its bytes with `chmod`'s error.
