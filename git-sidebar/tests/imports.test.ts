import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Fresh 0.5.9 bundles the plugin's modules into one script, each in a
// function run once, in dependency order, that destructures its imports when
// it runs. It counts `import type` and `export … from` as dependencies too,
// and cannot order a cycle: the plugin then fails to load with
// `ReferenceError: __mod_<name> is not initialized`. Node runs a cycle
// without complaint and `fresh --check-plugin` only bundles, so this test is
// what catches one.

const root = new URL("../", import.meta.url);
const files = ["git_sidebar.ts", ...readdirSync(new URL("lib/", root)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`)];

/** The modules `file` imports or re-exports from, as paths like `lib/x.ts`. */
function depsOf(file: string): string[] {
  const text = readFileSync(new URL(file, root), "utf8");
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"(\.\.?\/[^"]+)"/gms)) {
    const parts = `${dir}${m[1]}`.split("/");
    const norm: string[] = [];
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") norm.pop();
      else norm.push(p);
    }
    out.push(norm.join("/"));
  }
  return out;
}

test("no import cycle among the plugin's modules, type imports included (Fresh's bundler cannot load one)", () => {
  const graph = new Map(files.map((f) => [f, depsOf(f)]));
  assert.ok((graph.get("lib/actions.ts") ?? []).includes("lib/graph.ts"), "the parser sees imports");
  const state = new Map<string, "open" | "done">();
  const visit = (f: string, path: string[]): void => {
    if (state.get(f) === "done") return;
    if (state.get(f) === "open") assert.fail(`import cycle: ${[...path.slice(path.indexOf(f)), f].join(" → ")}`);
    state.set(f, "open");
    for (const d of graph.get(f) ?? []) visit(d, [...path, f]);
    state.set(f, "done");
  };
  for (const f of files) visit(f, []);
});
