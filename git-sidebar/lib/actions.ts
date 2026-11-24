// What a row offers: its button (R5, R15, R16), its right-click menu (R17)
// and what the palette commands act on (R18). The button, Space, the menu
// and the palette all ask here, so they cannot disagree about a row.

import { trimSlash } from "./git.ts";
import { passable } from "./stage.ts";
import { unpassable, type Entry, type Status } from "./status.ts";
import { CHANGES_KEY, rowKind, STAGED_KEY, type EntryMap } from "./view.ts";

/** U+2212, the minus sign: the same width as `+` in a terminal font. */
export const MINUS = "−";

export type ActionKind = "stage" | "unstage" | "stageAll" | "unstageAll";

/** A row's action, or `none` with the message to show for it (null:
 *  nothing to say, as for an empty group or the `… N more` row). */
export type RowAction = { kind: ActionKind } | { kind: "none"; reason: string | null };

const NONE: RowAction = { kind: "none", reason: null };

/** Each action's button label (R5, R15, R16). */
const BUTTON_LABEL: Record<ActionKind, "+" | typeof MINUS> = {
  stage: "+",
  unstage: MINUS,
  stageAll: "+",
  unstageAll: MINUS,
};

/** Why a row whose name git can't be passed back is refused (`unpassable`). */
export function nameReason(path: string): string {
  return `${path}: the name is not valid UTF-8, so git can't be passed it back`;
}

/** The name `nameReason` gives for `e`: its path, or its original path when
 *  only that one is not UTF-8 (a rename or copy from such a name). */
export function badName(e: Entry): string {
  return e.orig !== undefined && !unpassable(e.path) && unpassable(e.orig) ? e.orig : trimSlash(e.path);
}

/** Why a directory row (a submodule or nested repository) is refused. */
export function dirReason(path: string): string {
  return `${path} is a directory (submodule or nested repository)`;
}

/** What the section shows when no row action can run: no status rows. */
export const NO_ROWS = "the Git section shows no files";

/** The action of the row `key` in `status` (null: no status shown, as
 *  under a notice). `entries` is `entryMap(status)`. */
export function rowAction(key: string, status: Status | null, entries: EntryMap): RowAction {
  if (status === null) return NONE;
  if (key === STAGED_KEY) return status.staged.length > 0 ? { kind: "unstageAll" } : NONE;
  if (key === CHANGES_KEY) return status.changes.length > 0 ? { kind: "stageAll" } : NONE;
  const listed = entries.get(key);
  if (listed === undefined) return NONE;
  const path = trimSlash(listed.entry.path);
  // `git add` on a nested repository embeds it (INV §9.5): no button (R15).
  if (listed.entry.dir) return { kind: "none", reason: dirReason(path) };
  // Status names it lossily: the write would name no file (INV §8, Review
  // fixes). No button, and Space says why (R15).
  if (!passable(listed.entry)) return { kind: "none", reason: nameReason(badName(listed.entry)) };
  if (listed.group === "staged") return { kind: "unstage" };
  // `git add` would mark the conflict resolved (INV §9.5): never staged (R15).
  if (listed.entry.marker === "!") return { kind: "none", reason: `${path} has a merge conflict; resolve it with git first` };
  return { kind: "stage" };
}

/** The button label of the row `key`, or null for none. */
export function buttonLabel(key: string, status: Status | null, entries: EntryMap): string | null {
  const a = rowAction(key, status, entries);
  return a.kind === "none" ? null : BUTTON_LABEL[a.kind];
}

export type MenuChoice = "diff" | "file" | ActionKind;

export interface MenuItem {
  choice: MenuChoice;
  label: string;
}

const ACTION_LABEL: Record<ActionKind, string> = {
  stage: "Stage",
  unstage: "Unstage",
  stageAll: "Stage All",
  unstageAll: "Unstage All",
};

/** The right-click menu of the row `key` (R17): View Diff, View File and
 *  the row's action on a file row; the action alone on a group row; nothing
 *  on any other row or a group with no action. */
export function menuItems(key: string, status: Status | null, entries: EntryMap): MenuItem[] {
  if (status === null) return [];
  const action = rowAction(key, status, entries);
  const items: MenuItem[] = [];
  if (entries.has(key)) {
    items.push({ choice: "diff", label: "View Diff" }, { choice: "file", label: "View File" });
  } else if (rowKind(key).kind !== "group") {
    return [];
  }
  if (action.kind !== "none") items.push({ choice: action.kind, label: ACTION_LABEL[action.kind] });
  return items;
}

export type PaletteCommand = "viewDiff" | "viewFile" | "toggle" | "stageAll" | "unstageAll";

/** What a palette command acts on (R18): a row key, or the message to
 *  show instead. */
export type PaletteTarget = { ok: true; key: string } | { ok: false; message: string };

export const NOTHING_SELECTED = "no row is selected in the Git section";

export function paletteTarget(cmd: PaletteCommand, selectedKey: string | null, status: Status | null, entries: EntryMap): PaletteTarget {
  if (status === null) return { ok: false, message: NO_ROWS };
  if (cmd === "stageAll" || cmd === "unstageAll") {
    // Whichever row is selected (R18).
    const key = cmd === "stageAll" ? CHANGES_KEY : STAGED_KEY;
    if (rowAction(key, status, entries).kind === "none") return { ok: false, message: cmd === "stageAll" ? "nothing to stage" : "nothing to unstage" };
    return { ok: true, key };
  }
  if (selectedKey === null) return { ok: false, message: NOTHING_SELECTED };
  const isFile = entries.has(selectedKey);
  if (cmd === "viewDiff" || cmd === "viewFile") {
    if (!isFile) return { ok: false, message: `${cmd === "viewDiff" ? "View Diff" : "View File"} needs a file row selected` };
    return { ok: true, key: selectedKey };
  }
  if (!isFile) return { ok: false, message: "Stage or Unstage needs a file row selected; use Stage All or Unstage All for a group" };
  const action = rowAction(selectedKey, status, entries);
  if (action.kind === "none") return { ok: false, message: action.reason ?? "this row cannot be staged or unstaged" };
  return { ok: true, key: selectedKey };
}

/** A menu button's widget key, and the choice it stands for. */
const MENU_KEY_PREFIX = "menu:";
const MENU_CHOICES: ReadonlySet<string> = new Set<MenuChoice>(["diff", "file", ...(Object.keys(BUTTON_LABEL) as ActionKind[])]);

export function menuChoice(widgetKey: string): MenuChoice | null {
  if (!widgetKey.startsWith(MENU_KEY_PREFIX)) return null;
  const c = widgetKey.slice(MENU_KEY_PREFIX.length);
  return MENU_CHOICES.has(c) ? (c as MenuChoice) : null;
}

/** The menu panel's content: a column of bare buttons, one per item. A
 *  choice comes back as `activate` with the button's `widget_key` (INV §8,
 *  P10). */
export function menuSpec(items: MenuItem[]): { kind: "col"; children: unknown[] } {
  return {
    kind: "col",
    children: items.map((i) => ({
      kind: "button",
      label: ` ${i.label} `,
      focused: false,
      intent: "normal",
      key: `${MENU_KEY_PREFIX}${i.choice}`,
      disabled: false,
      focusable: true,
      bare: true,
      fullWidth: false,
    })),
  };
}

/** `floatingPanelControl(id, "anchor", arg)` packs a screen cell as
 *  `y << 16 | x`. A right-click reports the 0-based cell under the
 *  pointer; the menu goes on the row below it, so the row stays visible
 *  (INV §9.3, §8 P10). */
export function anchorArg(col: number, row: number): number {
  return (Math.max(0, row) + 1) * 65536 + Math.max(0, col);
}
