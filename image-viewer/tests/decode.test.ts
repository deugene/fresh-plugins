import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64ToBytes, parseBmp, parsePam, type Image } from "../lib/decode.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const decoded = (name: string) => base64ToBytes(fixture(name));
const px = (img: Image, x: number, y: number) => Array.from(img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const near = (a: number[], b: number[], tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test("base64ToBytes: padding, no padding, and wrapped lines (Linux base64, INV §8 P23)", () => {
  assert.deepEqual(Array.from(base64ToBytes("TWFu")), [77, 97, 110]);
  assert.deepEqual(Array.from(base64ToBytes("TWE=")), [77, 97]);
  assert.deepEqual(Array.from(base64ToBytes("TQ==")), [77]);
  assert.deepEqual(Array.from(base64ToBytes("TQ")), [77]);
  assert.deepEqual(Array.from(base64ToBytes("TW\nFu\r\n TQ==\n")), [77, 97, 110, 77]);
  assert.deepEqual(Array.from(base64ToBytes("")), []);
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(base64ToBytes(Buffer.from(all).toString("base64").replace(/(.{76})/g, "$1\n")), all);
});

test("parsePam: a recorded ffmpeg fit render of quadrants.png (R2)", () => {
  const img = parsePam(decoded("quadrants-fit.pam.b64"));
  assert.deepEqual([img.w, img.h], [40, 30]);
  assert.deepEqual(px(img, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 37, 2), [0, 255, 0, 255]);
  assert.deepEqual(px(img, 2, 27), [0, 0, 255, 255]);
  assert.deepEqual(px(img, 37, 27), [255, 255, 255, 255]);
});

test("parsePam: a 1:1 crop holds the centre mark exactly (INV §8 P25)", () => {
  const img = parsePam(decoded("quadrants-centre.pam.b64"));
  assert.deepEqual([img.w, img.h], [4, 4]);
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(img, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(px(img, 2, 2), [0, 0, 0, 255]);
  assert.deepEqual(px(img, 3, 3), [255, 255, 255, 255]);
});

test("parsePam: alpha, EXIF orientation and the first GIF frame (R2)", () => {
  const alpha = parsePam(decoded("alpha-fit.pam.b64"));
  assert.deepEqual(px(alpha, 2, 5), [255, 0, 255, 255]);
  assert.equal(px(alpha, 17, 5)[3], 0);
  const o6 = parsePam(decoded("o6-fit.pam.b64"));
  assert.deepEqual([o6.w, o6.h], [30, 40], "Orientation=6 comes out taller than wide");
  const gif = parsePam(decoded("anim-frame1.pam.b64"));
  assert.ok(near(px(gif, 4, 3), [255, 0, 0, 255]), `frame 1 is red: ${px(gif, 4, 3)}`);
});

test("parsePam: depths 1–4, MAXVAL scaling, BLACKANDWHITE (INV §8 P23)", () => {
  const one = parsePam(bytesOf("P7\nWIDTH 2\nHEIGHT 1\nDEPTH 1\nMAXVAL 255\nTUPLTYPE GRAYSCALE\nENDHDR\n\x10\xf0"));
  assert.deepEqual(px(one, 0, 0), [16, 16, 16, 255]);
  assert.deepEqual(px(one, 1, 0), [240, 240, 240, 255]);
  const bw = parsePam(bytesOf("P7\nWIDTH 2\nHEIGHT 1\nDEPTH 1\nMAXVAL 1\nTUPLTYPE BLACKANDWHITE\nENDHDR\n\x00\x01"));
  assert.deepEqual([px(bw, 0, 0), px(bw, 1, 0)], [[0, 0, 0, 255], [255, 255, 255, 255]]);
  const ga = parsePam(bytesOf("P7\nWIDTH 1\nHEIGHT 1\nDEPTH 2\nMAXVAL 255\nTUPLTYPE GRAYSCALE_ALPHA\nENDHDR\n\x3c\x80"));
  assert.deepEqual(px(ga, 0, 0), [60, 60, 60, 128]);
  const rgb = parsePam(bytesOf("P7\nWIDTH 1\nHEIGHT 1\nDEPTH 3\nMAXVAL 15\nTUPLTYPE RGB\nENDHDR\n\x0f\x00\x05"));
  assert.deepEqual(px(rgb, 0, 0), [255, 0, 85, 255]);
  const rgba = parsePam(bytesOf("P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n\x01\x02\x03\x04"));
  assert.deepEqual(px(rgba, 0, 0), [1, 2, 3, 4]);
});

test("parsePam: skips # comment lines, as ImageMagick writes for a JPEG (INV §8 P23)", () => {
  const img = parsePam(bytesOf("P7\n#Lavc62.28.100\nWIDTH 1\nHEIGHT 1\nDEPTH 3\n# another\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n\x0a\x14\x1e"));
  assert.deepEqual(px(img, 0, 0), [10, 20, 30, 255]);
});

test("parsePam: a header longer than 4 KB, as a long image comment makes it (INV §8 P23)", () => {
  const comment = "#" + "c".repeat(9000) + "\n";
  const img = parsePam(bytesOf(`P7\n${comment}WIDTH 1\nHEIGHT 1\n${comment}DEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n\x07\x08\x09`));
  assert.deepEqual(px(img, 0, 0), [7, 8, 9, 255]);
  assert.throws(() => parsePam(bytesOf(`P7\n${comment}WIDTH 1\n`)), /not a PAM/);
});

test("parsePam: a greyscale input recorded through ffmpeg", () => {
  const img = parsePam(decoded("grey-crop.pam.b64"));
  assert.deepEqual([img.w, img.h], [8, 6]);
  assert.deepEqual(px(img, 0, 0), [40, 40, 40, 255]);
  assert.deepEqual(px(img, 7, 5), [68, 68, 68, 255]);
});

test("parsePam: rejects other files and short data", () => {
  assert.throws(() => parsePam(bytesOf("this is not a png\n")));
  assert.throws(() => parsePam(bytesOf("P7\nWIDTH 2\nHEIGHT 2\nDEPTH 3\nMAXVAL 255\nENDHDR\n\x00")));
  assert.throws(() => parsePam(bytesOf("P7\nWIDTH 1\nHEIGHT 1\nDEPTH 5\nMAXVAL 255\nENDHDR\n\x00\x00\x00\x00\x00")));
  assert.throws(() => parsePam(bytesOf("P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 65535\nENDHDR\n\x00\x00")));
});

test("parseBmp: recorded sips output, 24-bit and 32-bit BITFIELDS, top-down (P22)", () => {
  const q = parseBmp(decoded("quadrants-sips.bmp.b64"));
  assert.deepEqual([q.w, q.h], [40, 30]);
  assert.ok(near(px(q, 2, 2), [255, 0, 0, 255]), String(px(q, 2, 2)));
  assert.ok(near(px(q, 37, 2), [0, 255, 0, 255]), String(px(q, 37, 2)));
  assert.ok(near(px(q, 2, 27), [0, 0, 255, 255]), String(px(q, 2, 27)));
  assert.ok(near(px(q, 37, 27), [255, 255, 255, 255]), String(px(q, 37, 27)));
  const a = parseBmp(decoded("alpha-sips.bmp.b64"));
  assert.ok(near(px(a, 2, 5), [255, 0, 255, 255]), String(px(a, 2, 5)));
  assert.equal(px(a, 17, 5)[3], 0);
  const g = parseBmp(decoded("grey-sips.bmp.b64"));
  assert.deepEqual([g.w, g.h], [8, 6]);
  const o6 = parseBmp(decoded("o6-sips.bmp.b64"));
  assert.deepEqual([o6.w, o6.h], [30, 40]);
  const c = parseBmp(decoded("quadrants-centre-sips.bmp.b64"));
  assert.deepEqual([c.w, c.h], [4, 4]);
  assert.deepEqual([px(c, 0, 0), px(c, 1, 1), px(c, 3, 3)], [[255, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255]]);
});

/** A tiny BMP: `rows` top to bottom, each pixel [r,g,b]. */
function bmp24(rows: number[][][], topDown: boolean): Uint8Array {
  const h = rows.length;
  const w = rows[0].length;
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, topDown ? -h : h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rows[y][x];
      out[row + x * 3] = b;
      out[row + x * 3 + 1] = g;
      out[row + x * 3 + 2] = r;
    }
  }
  return out;
}

test("parseBmp: 24-bit in both row orders, with row padding", () => {
  const rows = [
    [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
    [[10, 11, 12], [13, 14, 15], [16, 17, 18]],
  ];
  for (const topDown of [true, false]) {
    const img = parseBmp(bmp24(rows, topDown));
    assert.deepEqual([img.w, img.h], [3, 2]);
    assert.deepEqual(px(img, 0, 0), [1, 2, 3, 255]);
    assert.deepEqual(px(img, 2, 1), [16, 17, 18, 255]);
  }
});

test("parseBmp: rejects the headerless file sips writes for a small-palette PNG (INV §8 P25)", () => {
  assert.throws(() => parseBmp(decoded("pal-sips.bmp.b64")));
  assert.throws(() => parseBmp(bytesOf("this is not a png\n")));
});
