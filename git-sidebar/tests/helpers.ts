// Builders shared by the tests: recorded fixtures, porcelain records, and
// the results of `pwd` and `docker inspect` in a container.

import { readFileSync } from "node:fs";
import { parseStatus, type Status } from "../lib/status.ts";
import type { TreeSpec } from "../lib/view.ts";

/** A recorded `git status` output, tests/fixtures/<name>.z. */
export const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}.z`, import.meta.url), "utf8");

/** Any recorded output, tests/fixtures/<file>, as git printed it. */
export const recorded = (file: string): string => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");

/** A recorded `git status` output, parsed. */
export const status = (name: string): Status => parseStatus(fixture(name));

/** Every row's text, the shape tree assertions read best in. */
export const texts = (spec: TreeSpec): string[] => spec.nodes.map((n) => n.text.text);

/** An object id. */
export const H = "0".repeat(40);

/** Raw `status --porcelain=v2 --branch -z` output: `ab` null means no upstream. */
export function raw(opts: { branch?: string; ab?: string | null; records?: string[] }): string {
  const lines = [`# branch.oid ${"1".repeat(40)}`, `# branch.head ${opts.branch ?? "main"}`];
  if (opts.ab !== null) lines.push("# branch.upstream origin/main", `# branch.ab ${opts.ab ?? "+1 -0"}`);
  return [...lines, ...(opts.records ?? [])].map((l) => l + "\0").join("");
}

/** An ordinary changed-file record with status `xy`. */
export const mod = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;
export const untracked = (path: string): string => `? ${path}`;

/** `n` untracked records, `<prefix>0000.txt` onwards. */
export const manyUntracked = (n: number, prefix = "f"): string[] =>
  Array.from({ length: n }, (_, i) => untracked(`${prefix}${String(i).padStart(4, "0")}.txt`));

/** The paths a command carries: everything after its `--`. */
export const pathsOf = (argv: string[]): string[] => argv.slice(argv.indexOf("--") + 1);

/** `pwd` in the container printing `dir`. */
export const pwdResult = (dir: string) => ({ code: 0, stdout: dir + "\n", stderr: "" });
/** `docker inspect <id> --format '{{json .Mounts}}'` listing `mounts`. */
export const inspectResult = (...mounts: object[]) => ({ code: 0, stdout: JSON.stringify(mounts) + "\n", stderr: "" });
/** The volume workspace P8 recorded on colima. */
export const GS_VOLUME = {
  Type: "volume",
  Name: "gs-vol",
  Source: "/var/lib/docker/volumes/gs-vol/_data",
  Destination: "/workspaces/gs",
};
