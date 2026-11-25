// What a row offers: its button (R5, R15, R16), its right-click menu (R17)
// and what the palette commands act on (R18), Resolve Conflict (R25), the
// Graph's commit commands (R33) and Pull and Push (R34, R35) included. The
// button, Space, the menu and the palette all ask here, so they cannot
// disagree about a row. A Graph row has no button and no write: `rowAction`
// reads only the status rows' `EntryMap`, which holds no Graph row.

import { trimSlash } from "./git.ts";
import { commitKey, commitOf, GRAPH_KEY, graphKind, type GraphRows } from "./graph.ts";
import { passable } from "./stage.ts";
import { badName, dirReason, nameReason, type Status } from "./status.ts";
import { CHANGES_KEY, rowKind, STAGED_KEY, type EntryMap } from "./view.ts";

/** U+2212, the minus sign: the same width as `+` in a terminal font. */
export const MINUS = "−";

const ACTION_KINDS = ["stage", "unstage", "stageAll", "unstageAll"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

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

/** View Commit, the copies, Pull and Push (R33–R35): menu choices and
 *  palette commands both, routed alike (`isGraphCommand`). One list for
 *  both types and the check, so none can miss one. */
const GRAPH_COMMANDS = ["viewCommit", "copyId", "copyMessage", "pull", "push"] as const;
export type GraphCommand = (typeof GRAPH_COMMANDS)[number];
const GRAPH_COMMAND_SET: ReadonlySet<string> = new Set<GraphCommand>(GRAPH_COMMANDS);

export function isGraphCommand(c: string): c is GraphCommand {
  return GRAPH_COMMAND_SET.has(c);
}

/** A menu item: a view, the row's button action, Resolve Conflict on a
 *  conflicted row (R25), Commit… on Staged Changes (R26), a commit's View
 *  Commit and copies (R33), or Pull and Push on the Graph group (R34, R35).
 *  One list, so the type and `menuChoice`'s set cannot disagree. */
const MENU_CHOICE_LIST = ["diff", "file", "resolve", "commit", ...GRAPH_COMMANDS, ...ACTION_KINDS] as const;
export type MenuChoice = (typeof MENU_CHOICE_LIST)[number];

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

/** Whether the row `key` is a conflicted file (`!`, under Changes): the one
 *  row Resolve Conflict acts on (R25). */
export function conflicted(key: string, entries: EntryMap): boolean {
  const listed = entries.get(key);
  return listed !== undefined && listed.group === "changes" && listed.entry.marker === "!";
}

/** The items of a commit's menu (R17, R33). Their labels also name the
 *  palette commands when no commit is selected. */
const COMMIT_ITEMS = [
  { choice: "viewCommit", label: "View Commit" },
  { choice: "copyId", label: "Copy Commit ID" },
  { choice: "copyMessage", label: "Copy Commit Message" },
] as const satisfies readonly MenuItem[];
/** What View Commit and the copies say without a commit to act on (R18). */
const COMMIT_NAME = Object.fromEntries(COMMIT_ITEMS.map((i) => [i.choice, i.label])) as Record<(typeof COMMIT_ITEMS)[number]["choice"], string>;
const REMOTE_ITEMS: MenuItem[] = [
  { choice: "pull", label: "Pull" },
  { choice: "push", label: "Push" },
];

/** The right-click menu of the row `key` (R17): View Diff, View File and
 *  the row's action on a file row, Resolve Conflict on a conflicted one
 *  (R25); the action alone on a group row, and Commit… on Staged Changes
 *  while it lists a file (R26); Pull and Push on the Graph group (R34,
 *  R35); View Commit and the copies on a commit, View Diff and View File on
 *  a commit's file (R33, R32); nothing on any other row, Load more and a
 *  cap row included, or a group with no action. */
export function menuItems(key: string, status: Status | null, entries: EntryMap, graph: GraphRows): MenuItem[] {
  if (status === null) return [];
  if (key === GRAPH_KEY) return [...REMOTE_ITEMS];
  const g = graphKind(key);
  if (g !== null) {
    if (!graph.has(key)) return [];
    if (g.kind === "commit") return [...COMMIT_ITEMS];
    if (g.kind === "commitFile") return [{ choice: "diff", label: "View Diff" }, { choice: "file", label: "View File" }];
    return [];
  }
  const action = rowAction(key, status, entries);
  const items: MenuItem[] = [];
  if (entries.has(key)) {
    items.push({ choice: "diff", label: "View Diff" }, { choice: "file", label: "View File" });
  } else if (rowKind(key).kind !== "group") {
    return [];
  }
  if (action.kind !== "none") items.push({ choice: action.kind, label: ACTION_LABEL[action.kind] });
  if (conflicted(key, entries)) items.push({ choice: "resolve", label: "Resolve Conflict" });
  if (key === STAGED_KEY && status.staged.length > 0) items.push({ choice: "commit", label: "Commit…" });
  return items;
}

export type PaletteCommand = "viewDiff" | "viewFile" | "toggle" | "stageAll" | "unstageAll" | "resolve" | "commit" | GraphCommand;

/** What a palette command acts on (R18): a row key, or the message to
 *  show instead. */
export type PaletteTarget = { ok: true; key: string } | { ok: false; message: string };

export const NOTHING_SELECTED = "no row is selected in the Git section";
/** Focus, or a key bound to it, where the active window has no section (R22, R28). */
export const NOT_SHOWN = "the Git section is not shown";
export const NOTHING_STAGED = "nothing staged to commit";

export function paletteTarget(
  cmd: PaletteCommand,
  selectedKey: string | null,
  status: Status | null,
  entries: EntryMap,
  graph: GraphRows,
): PaletteTarget {
  if (status === null) return { ok: false, message: NO_ROWS };
  // Commit… acts on Staged Changes whichever row is selected (R18, R26).
  if (cmd === "commit") return status.staged.length > 0 ? { ok: true, key: STAGED_KEY } : { ok: false, message: NOTHING_STAGED };
  // Pull and Push act on the branch whichever row is selected (R18, R34, R35).
  if (cmd === "pull" || cmd === "push") return { ok: true, key: GRAPH_KEY };
  if (cmd === "viewCommit" || cmd === "copyId" || cmd === "copyMessage") {
    // The selected commit, or a selected commit file's commit (R18, R33).
    const commit = selectedKey === null ? null : commitOf(selectedKey, graph);
    if (commit === null) return { ok: false, message: `${COMMIT_NAME[cmd]} needs a commit selected in the Graph` };
    return { ok: true, key: commitKey(commit.id) };
  }
  if (cmd === "stageAll" || cmd === "unstageAll") {
    // Whichever row is selected (R18).
    const key = cmd === "stageAll" ? CHANGES_KEY : STAGED_KEY;
    if (rowAction(key, status, entries).kind === "none") return { ok: false, message: cmd === "stageAll" ? "nothing to stage" : "nothing to unstage" };
    return { ok: true, key };
  }
  if (selectedKey === null) return { ok: false, message: NOTHING_SELECTED };
  if (cmd === "resolve") {
    return conflicted(selectedKey, entries) ? { ok: true, key: selectedKey } : { ok: false, message: "Resolve Conflict needs a file with a merge conflict selected" };
  }
  const isFile = entries.has(selectedKey);
  if (cmd === "viewDiff" || cmd === "viewFile") {
    // A commit's file too (R18, R32).
    const commitFile = graphKind(selectedKey)?.kind === "commitFile" && graph.has(selectedKey);
    if (!isFile && !commitFile) return { ok: false, message: `${cmd === "viewDiff" ? "View Diff" : "View File"} needs a file row selected` };
    return { ok: true, key: selectedKey };
  }
  if (!isFile) return { ok: false, message: "Stage or Unstage needs a file row selected; use Stage All or Unstage All for a group" };
  const action = rowAction(selectedKey, status, entries);
  if (action.kind === "none") return { ok: false, message: action.reason ?? "this row cannot be staged or unstaged" };
  return { ok: true, key: selectedKey };
}

/** A menu button's widget key, and the choice it stands for. */
const MENU_KEY_PREFIX = "menu:";
const MENU_CHOICES: ReadonlySet<string> = new Set<MenuChoice>(MENU_CHOICE_LIST);

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
