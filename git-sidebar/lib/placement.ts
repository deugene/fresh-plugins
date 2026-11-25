// Where a section tab opens (R37): never in Fresh's utility dock. Fresh
// 0.5.9 does not say which split is the dock (INV §13.1, §8 P41 c), but
// files never open there, so the dock is told apart by elimination: a tab
// opens where the tab it replaces is, else where a file or a section tab
// was last active, else in the first pane showing a file, else top-left.

/** A pane as `describeWorkspace` lists it, the fields read here. */
export interface PaneLike {
  splitId: number;
  kind: string;
}

/**
 * The splits to try for a section tab, best first, each once (R37 "Which
 * split"): the split of the tab it replaces, the split tracked as last used
 * for a file or a section tab, the first pane showing a file, then the
 * top-left pane (`panes` come in visual order, top-left first). Each still
 * has to be checked to exist before it is focused: a focus on a split that
 * is gone logs a WARN (INV §8 P42 e).
 */
export function splitCandidates(o: { replacing: number | null; last: number | null; panes: PaneLike[] }): number[] {
  const out: number[] = [];
  const add = (id: number | null | undefined) => {
    if (id !== null && id !== undefined && !out.includes(id)) out.push(id);
  };
  add(o.replacing);
  add(o.last);
  add(o.panes.find((p) => p.kind === "file")?.splitId);
  add(o.panes[0]?.splitId);
  return out;
}

/** Whether a buffer is a file: not virtual. A terminal has a path (its
 *  scrollback file), so a path does not tell (H12); `is_virtual` is true
 *  for terminals and plugin buffers alike. */
export function isFile(info: { is_virtual: boolean } | null): boolean {
  return info !== null && info.is_virtual === false;
}
