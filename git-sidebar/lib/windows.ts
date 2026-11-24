// Which panel id each window's Git section uses (R28, INV §11.1, §11.2).
//
// A panel id is the plugin's, not a window's: Fresh 0.5.9 keeps one section
// per id, editor-wide, and a mount with another window's scope moves it. So
// each window's section needs an id of its own. The host saves a section's
// collapsed state in its window's workspace file under that id, and window
// ids change on every launch, so the id comes from the workspace's stable id.
// Its folder is no good on its own: two windows can share one (a tab
// extracted into a window of its own, INV §8 P31 e).

/** The id of the one section the plugin mounted before R28. Load unmounts
 *  it, as the host keeps a section across a plugin reload (INV §2). */
export const LEGACY_PANEL = 1;
/** Ids below this are taken: 0 is the host's prompt toolbar (INV §11.1),
 *  1 the legacy section, 2 the right-click menu (R17). */
const FIRST = 3;
/** How many ids there are from FIRST: the host reads an id as `f64 as u64`,
 *  so any integer up to 2^32 survives. */
const SPAN = 2 ** 32 - FIRST;

/** What identifies a window's workspace across launches: its stable id, or
 *  its folder for a workspace file written before stable ids (empty). */
export function windowKey(stableId: string, root: string): string {
  return stableId !== "" ? stableId : `root:${root}`;
}

/** 32-bit FNV-1a over the UTF-16 code units of `s`. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The panel id for the workspace `key`, stepping past ids another live
 *  section holds (`taken`). Only a hash collision steps, so the id is the
 *  same on every launch. */
export function panelIdFor(key: string, taken: ReadonlySet<number>): number {
  let id = FIRST + (fnv1a(key) % SPAN);
  while (taken.has(id)) id = id + 1 < FIRST + SPAN ? id + 1 : FIRST;
  return id;
}
