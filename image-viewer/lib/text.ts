// Text helpers shared by the header and the failure reasons.

/** `s` cut to at most `max` code points, ending in `mark` when it was cut
 *  (R3's narrow header, R11's one-line reason). */
export function clip(s: string, max: number, mark = ""): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, Math.max(0, max - Array.from(mark).length)).join("") + mark;
}
