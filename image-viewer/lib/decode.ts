// Decoders for what the image tools write (R2): base64 text, PAM (ffmpeg and
// ImageMagick) and BMP (sips). The runtime has no atob and no TextDecoder
// (INV §5, P9), so all three are by hand. Each image comes out as straight
// RGBA, row by row from the top.

export interface Image {
  w: number;
  h: number;
  /** w·h·4 bytes: R, G, B, A, rows from the top. */
  rgba: Uint8Array;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LUT = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Base64 to bytes. Skips whitespace and anything else outside the
 *  alphabet, because Linux `base64` wraps its output at 76 characters
 *  (INV §8 P23), and stops at the first `=`. */
export function base64ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) break; // "="
    const v = c < 128 ? LUT[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** A PAM file (magic `P7`), DEPTH 1–4 with MAXVAL 1–255 scaled to 255. The
 *  header may hold `#` comment lines: ImageMagick copies a JPEG's comment
 *  there (INV §8 P23). Throws on anything else. */
export function parsePam(bytes: Uint8Array): Image {
  // The header has no length limit: ImageMagick copies an image comment of
  // any length into it (INV §8 P23). Find "ENDHDR\n" first, then decode.
  const END = [69, 78, 68, 72, 68, 82, 10];
  if (bytes.length < 3 || bytes[0] !== 0x50 || bytes[1] !== 0x37 || bytes[2] !== 10) throw new Error("not a PAM image");
  let i = -1;
  for (let p = 3; p + END.length <= bytes.length; p++) {
    let k = 0;
    while (k < END.length && bytes[p + k] === END[k]) k++;
    if (k === END.length && bytes[p - 1] === 10) {
      i = p + END.length - 1;
      break;
    }
  }
  if (i < 0) throw new Error("not a PAM image");
  let header = "";
  for (let p = 0; p <= i; p += 8192) header += String.fromCharCode(...bytes.subarray(p, Math.min(i + 1, p + 8192)));
  const fields = new Map<string, string>();
  for (const raw of header.split("\n").slice(1)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line === "ENDHDR") continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1).trim();
    fields.set(key, value);
  }
  const w = Number(fields.get("WIDTH"));
  const h = Number(fields.get("HEIGHT"));
  const depth = Number(fields.get("DEPTH"));
  const maxval = Number(fields.get("MAXVAL"));
  if (!(w > 0 && h > 0) || !Number.isInteger(w) || !Number.isInteger(h)) throw new Error("bad PAM size");
  if (!(depth >= 1 && depth <= 4)) throw new Error(`PAM depth ${fields.get("DEPTH")} not supported`);
  if (!(maxval >= 1 && maxval <= 255)) throw new Error(`PAM maxval ${fields.get("MAXVAL")} not supported`);
  const data = bytes.subarray(i + 1);
  if (data.length < w * h * depth) throw new Error("PAM data is short");
  const rgba = new Uint8Array(w * h * 4);
  const scale = (v: number) => (maxval === 255 ? v : Math.round((v * 255) / maxval));
  for (let p = 0, s = 0, d = 0; p < w * h; p++, s += depth, d += 4) {
    if (depth <= 2) {
      const g = scale(data[s]);
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = depth === 2 ? scale(data[s + 1]) : 255;
    } else {
      rgba[d] = scale(data[s]);
      rgba[d + 1] = scale(data[s + 1]);
      rgba[d + 2] = scale(data[s + 2]);
      rgba[d + 3] = depth === 4 ? scale(data[s + 3]) : 255;
    }
  }
  return { w, h, rgba };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/** Reads one channel through a BITFIELDS mask, scaled to 0–255. */
function channel(v: number, mask: number, fallback: number): number {
  if (mask === 0) return fallback;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  const x = (v & mask) >>> shift;
  return max === 255 ? x : Math.round((x * 255) / max);
}

/** A BMP as sips writes it (INV §5, P22): 24-bit, or 32-bit `BI_RGB` or
 *  `BI_BITFIELDS`, rows top-down (negative height) or bottom-up. Throws on
 *  anything else, such as the headerless file sips writes for a palette PNG
 *  with a small palette (INV §8 P25). */
export function parseBmp(bytes: Uint8Array): Image {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error("not a BMP image");
  const offset = u32(bytes, 10);
  const headerSize = u32(bytes, 14);
  const w = i32(bytes, 18);
  const rawH = i32(bytes, 22);
  const bpp = u16(bytes, 28);
  const compression = u32(bytes, 30);
  const h = Math.abs(rawH);
  if (w <= 0 || h === 0) throw new Error("bad BMP size");
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP depth ${bpp} not supported`);
  if (compression !== 0 && !(compression === 3 && bpp === 32)) throw new Error(`BMP compression ${compression} not supported`);
  const masks = compression === 3 ? [u32(bytes, 54), u32(bytes, 58), u32(bytes, 62), headerSize >= 56 ? u32(bytes, 66) : 0] : null;
  const px = bpp / 8;
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  if (offset + stride * h > bytes.length) throw new Error("BMP data is short");
  const topDown = rawH < 0;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = offset + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      if (masks === null) {
        // BI_RGB: B, G, R, and at 32 bits a fourth byte with no meaning.
        const s = row + x * px;
        rgba[d] = bytes[s + 2];
        rgba[d + 1] = bytes[s + 1];
        rgba[d + 2] = bytes[s];
        rgba[d + 3] = 255;
      } else {
        const v = u32(bytes, row + x * 4);
        rgba[d] = channel(v, masks[0], 0);
        rgba[d + 1] = channel(v, masks[1], 0);
        rgba[d + 2] = channel(v, masks[2], 0);
        rgba[d + 3] = channel(v, masks[3], 255);
      }
    }
  }
  return { w, h, rgba };
}
