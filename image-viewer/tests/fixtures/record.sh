#!/usr/bin/env bash
# Records real converter output for tests/decode.test.ts and tests/tools.test.ts,
# as text: ffmpeg PAM and sips BMP base64-encoded (*.b64), and the stderr or
# stdout of the size probes (*.txt). Built from tests/live/images.sh, with the
# argv shapes lib/tools.ts plans. Needs ffmpeg; the sips fixtures need macOS.
# Don't hand-edit the outputs: change this script and re-run it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/iv-fixtures.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
IMG=$(bash "$HERE/../live/images.sh" "$WORK/imgs")

# Sets IN to ffmpeg's input options for a file, as lib/tools.ts's
# ffmpegInput gives them (INV §8 P30). The fixtures' names have no %, so
# nothing more is forced. (macOS bash 3.2: no mapfile, no ${x,,}.)
ffin() {
  local f c
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *.png) f=png_pipe,apng,image2 c=png,apng ;;
    *.jpg | *.jpeg) f=jpeg_pipe,jpeg_mpf,jpegls_pipe,image2 c=mjpeg,jpegls ;;
    *.gif) f=gif,gif_pipe,image2 c=gif ;;
    *.bmp) f=bmp_pipe,image2 c=bmp ;;
    *.webp) f=webp_pipe,webp_anim,image2 c=webp,webp_anim ;;
    *.tif | *.tiff) f=tiff_pipe,image2 c=tiff ;;
    *) echo "no limits for $1" >&2; exit 1 ;;
  esac
  IN=(-format_whitelist "$f" -codec_whitelist "$c" -i "$1")
}

# ffmpeg render: crop, then scale when the view is below 100% (INV §8 P25: exact=1),
# premultiplied in 16 bits unless the file is a JPEG (INV §8 P33).
pam() { # name src w h x y [ow oh]
  local vf="crop=$3:$4:$5:$6:exact=1" scale
  if [[ $# -ge 8 ]]; then
    scale="scale=$7:$8:flags=area"
    case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
      *.jpg | *.jpeg) vf="$vf,$scale" ;;
      *) vf="$vf,format=gbrap16le,premultiply=inplace=1,$scale,unpremultiply=inplace=1" ;;
    esac
  fi
  ffin "$IMG/$2"
  ffmpeg -nostdin -v error "${IN[@]}" -frames:v 1 -vf "$vf,format=rgba" -c:v pam -f image2 -update 1 -y "$WORK/$1.pam"
  base64 < "$WORK/$1.pam" > "$HERE/$1.pam.b64"
}
pam quadrants-fit quadrants.png 400 300 0 0 40 30
pam quadrants-centre quadrants.png 4 4 198 148
pam alpha-fit alpha.png 200 100 0 0 20 10
pam o6-fit o6.jpg 300 400 0 0 30 40
pam anim-frame1 anim.gif 64 48 0 0 8 6
pam grey-crop grey.png 8 6 10 0

# ffmpeg size probe: its stderr, where showinfo prints the oriented size.
# The directory, pointer addresses and ffmpeg's speed are masked, so that
# re-recording changes nothing.
probe() { # input name label : the probe's stderr, as fixtures/<name>.showinfo.txt
  local dir; dir=$(dirname "$1"); ffin "$1"
  { ffmpeg -nostdin -hide_banner -v info "${IN[@]}" -frames:v 1 -vf showinfo -f null - 2>&1 || true; } \
    | sed -e "s#$dir#$3#g" -e "s/@ 0x[0-9a-f]*/@ 0x0/g" -e "s/speed=[^ ]*/speed=0/" > "$HERE/$2.showinfo.txt"
}
probe "$IMG/o6.jpg" o6 IMG
probe "$IMG/quadrants.png" quadrants IMG
# A file ffmpeg opens but cannot decode: the error comes after the Input #0
# header (INV §8 P27).
head -c 30 "$IMG/quad.gif" > "$WORK/truncated.gif"
probe "$WORK/truncated.gif" truncated WORK
probe "$IMG/corrupt.png" corrupt IMG
# Misnamed files: JPEG and PPM data named .png fail on the limits (P30).
probe "$IMG/mis.png" mis IMG
probe "$IMG/ppm.png" ppm IMG

if command -v sips >/dev/null 2>&1; then
  bmp() { # name src [h w] : convert (orienting), then resample
    sips -s format bmp "$IMG/$2" --out "$WORK/$1.0.bmp" >/dev/null
    if [[ $# -ge 4 ]]; then sips -z "$3" "$4" "$WORK/$1.0.bmp" --out "$WORK/$1.bmp" >/dev/null; else cp "$WORK/$1.0.bmp" "$WORK/$1.bmp"; fi
    base64 < "$WORK/$1.bmp" > "$HERE/$1.bmp.b64"
  }
  bmp quadrants-sips quadrants.png 30 40
  bmp alpha-sips alpha.png 10 20
  # A palette PNG with a 4-colour palette: sips writes its pixels with no BMP header (INV §8 P25).
  bmp pal-sips pal.png
  bmp grey-sips grey.png 6 8
  bmp o6-sips o6.jpg 40 30
  # A pad pass, then a crop at (y+1, x+1): the 4x4 around the centre mark (P22).
  sips -s format bmp "$IMG/quadrants.png" --out "$WORK/q0.bmp" >/dev/null
  sips -p 302 402 "$WORK/q0.bmp" --out "$WORK/q1.bmp" >/dev/null
  sips -c 4 4 --cropOffset 149 199 "$WORK/q1.bmp" --out "$WORK/q2.bmp" >/dev/null
  base64 < "$WORK/q2.bmp" > "$HERE/quadrants-centre-sips.bmp.b64"
  sips -g pixelWidth -g pixelHeight "$WORK/q0.bmp" | tail -2 > "$HERE/quadrants.sips-size.txt"
fi
ls "$HERE"
