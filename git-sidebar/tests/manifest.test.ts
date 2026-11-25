import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const dir = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", dir), "utf8"));

// Built-in plugin stems a package must not reuse (INV §4).
const BUILT_IN = [
  "git_blame", "git_explorer", "git_find_file", "git_grep", "git_gutter", "git_log", "git_statusbar",
  "live_diff", "diff_nav", "merge_conflict", "audit_mode", "compare_files",
];

test("manifest passes Fresh's install-time validation (pkg.ts validatePackage)", () => {
  assert.equal(typeof pkg.name, "string");
  assert.equal(pkg.name, "git-sidebar");
  assert.ok(["plugin", "theme", "language", "bundle"].includes(pkg.type));
  assert.equal(pkg.type, "plugin");
  const entry = pkg.fresh?.entry ?? pkg.fresh?.main ?? `${pkg.name}.ts`;
  assert.ok(existsSync(new URL(entry, dir)), `entry ${entry} exists`);
});

test("manifest fields", () => {
  assert.equal(pkg.$schema, "https://raw.githubusercontent.com/sinelaw/fresh/main/crates/fresh-editor/plugins/schemas/package.schema.json");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository, "https://github.com/deugene/fresh-plugins#git-sidebar");
  assert.deepEqual(pkg.fresh, { min_version: "0.5.9", min_api_version: 2, entry: "git_sidebar.ts" });
  // Fresh's schema owns `dependencies`; build tools are devDependencies only.
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.devDependencies.typescript.startsWith("~5."));
  assert.ok(typeof pkg.scripts.check === "string");
});

test("exactly one top-level .ts, and its stem is not a built-in plugin name", () => {
  // Fresh loads every top-level .ts/.js of a package as its own plugin.
  const top = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.includes(".i18n."));
  assert.deepEqual(top, ["git_sidebar.ts"]);
  const stem = top[0].replace(/\.ts$/, "");
  assert.ok(!BUILT_IN.includes(stem), stem);
  assert.equal(pkg.fresh.entry, top[0]);
});

test("the repo's registry lists the package with its manifest's fields (R12)", () => {
  // Fresh reads plugins.json from the root of its clone of a package source,
  // and matches an installed package to its entry by the manifest's name.
  // `↑` shows when latest_version is newer than the installed version.
  const registry = JSON.parse(readFileSync(new URL("../plugins.json", dir), "utf8"));
  assert.equal(registry.schema_version, 1);
  assert.deepEqual(registry.packages[pkg.name], {
    description: pkg.description,
    repository: pkg.repository,
    license: pkg.license,
    keywords: pkg.keywords,
    latest_version: pkg.version,
    fresh_min_version: pkg.fresh.min_version,
  });
});
