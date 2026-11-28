import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { layoutFor } from "./core.ts";
import { ensureProjects, projectSlug, renderProjectDoc, safeRemote, scanProject } from "./project-bootstrap.ts";

let temporary;
let layout;

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function repository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-b", "main");
  git(directory, "-c", "user.name=Bootstrap Test", "-c", "user.email=test@example.invalid",
    "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture");
}
const registryFile = () => JSON.parse(readFileSync(layout.registryPath, "utf8"));
function writeRegistry(projects, extra = {}) {
  writeFileSync(
    layout.registryPath,
    JSON.stringify({
      version: 1,
      rulesFile: "rules.md",
      dispatchers: [{ id: "global", name: "全局" }, { id: "other", name: "别人" }],
      projects,
      keep: ["feature-ui"],
      ...extra,
    }),
  );
}
const loaded = () => ({ ...registryFile(), projects: registryFile().projects });

before(() => {
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-bootstrap-")));
  layout = layoutFor(path.join(temporary, "home"));
  mkdirSync(layout.home, { recursive: true });
});
after(() => {
  assert.ok(path.basename(temporary).startsWith("paseo-bootstrap-"));
  rmSync(temporary, { recursive: true, force: true });
});

test("safeRemote drops credentials from a URL", () => {
  assert.equal(safeRemote("https://user:token@example.invalid/a/b.git"), "https://example.invalid/a/b.git");
  assert.equal(safeRemote("git@example.invalid:a/b.git"), "git@example.invalid:a/b.git");
});

test("projectSlug makes unique lowercase ids that start with a letter", () => {
  assert.equal(projectSlug("My Repo", new Set()), "my-repo");
  assert.equal(projectSlug("my-repo", new Set(["my-repo"])), "my-repo-2");
  assert.equal(projectSlug("123", new Set()), "p-123");
  assert.equal(projectSlug("项目", new Set()), "project");
});

test("an unregistered repository is registered with a PROJECT.md draft and progress directory", async () => {
  const repo = path.join(temporary, "repos", "shop-web");
  repository(repo);
  git(repo, "remote", "add", "origin", "https://user:secret-token@example.invalid/shop/web.git");
  writeFileSync(path.join(repo, "README.md"), "# Shop Web\n\nA storefront for the shop.\n");
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "shop-web", scripts: { dev: "vite", build: "vite build" }, dependencies: { vue: "3" } }));
  writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");
  writeFileSync(path.join(repo, ".env"), "SECRET=do-not-read\n");
  writeRegistry([]);
  const registry = loaded();

  const result = await ensureProjects(layout, registry, [repo], "global");

  assert.deepEqual(result.registered.map((item) => item.id), ["shop-web"]);
  assert.equal(result.drafted.length, 1);
  const entry = registryFile().projects[0];
  assert.equal(entry.owner, "global");
  assert.deepEqual(entry.repos, [repo]);
  assert.equal(entry.projectDoc, path.join(layout.home, "projects", "shop-web", "PROJECT.md"));
  assert.ok(existsSync(entry.statusDir));
  assert.deepEqual(registryFile().keep, ["feature-ui"], "keys outside the schema survive the rewrite");
  assert.equal(registry.projects.length, 1, "the registry in memory is updated too");

  const doc = readFileSync(entry.projectDoc, "utf8");
  assert.match(doc, /草稿/);
  assert.match(doc, /Shop Web：A storefront/);
  assert.match(doc, /pnpm dev/);
  assert.match(doc, /Vue/);
  assert.match(doc, /https:\/\/example\.invalid\/shop\/web\.git/);
  assert.doesNotMatch(doc, /secret-token|do-not-read/);
  assert.match(doc, /`\.env`/);
});

test("a registered project without a PROJECT.md gets one, and nothing is registered twice", async () => {
  const repo = path.join(temporary, "repos", "billing");
  repository(repo);
  writeRegistry([{ id: "billing", name: "Billing", owner: "global", repos: [repo], projectDoc: null }]);
  const registry = loaded();

  const first = await ensureProjects(layout, registry, [repo, path.join(repo)], "global");
  assert.deepEqual(first.registered, []);
  assert.equal(first.drafted.length, 1);
  assert.equal(registryFile().projects.length, 1);
  const entry = registryFile().projects[0];
  assert.ok(existsSync(entry.projectDoc));
  assert.ok(entry.note.includes("草稿"));

  const second = await ensureProjects(layout, registry, [repo], "global");
  assert.deepEqual(second, { registered: [], drafted: [], skipped: [] });
});

test("an existing PROJECT.md is linked, never overwritten", async () => {
  const repo = path.join(temporary, "repos", "legacy");
  repository(repo);
  const dir = path.join(temporary, "docs", "legacy");
  mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, "PROJECT.md");
  writeFileSync(doc, "hand written\n");
  writeRegistry([{ id: "legacy", name: "Legacy", owner: "global", repos: [repo], projectDoc: doc }]);
  const result = await ensureProjects(layout, loaded(), [repo], "global");
  assert.deepEqual(result.drafted, []);
  assert.equal(readFileSync(doc, "utf8"), "hand written\n");

  // A registered doc path that is missing on disk is drafted at that path.
  const gone = path.join(temporary, "docs", "gone", "PROJECT.md");
  writeRegistry([{ id: "legacy", name: "Legacy", owner: "global", repos: [repo], projectDoc: gone }]);
  await ensureProjects(layout, loaded(), [repo], "global");
  assert.match(readFileSync(gone, "utf8"), /草稿/);
});

test("another dispatcher's project is left alone", async () => {
  const repo = path.join(temporary, "repos", "theirs");
  repository(repo);
  writeRegistry([{ id: "theirs", name: "Theirs", owner: "other", repos: [repo], projectDoc: null }]);
  const result = await ensureProjects(layout, loaded(), [repo], "global");
  assert.equal(result.drafted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(registryFile().projects[0].projectDoc, null);
});

test("a linked worktree resolves to its main repository", async () => {
  const repo = path.join(temporary, "repos", "wt-main");
  repository(repo);
  const worktree = path.join(temporary, "repos", "wt-linked");
  git(repo, "worktree", "add", "--detach", worktree, "HEAD");
  writeRegistry([]);
  const result = await ensureProjects(layout, loaded(), [worktree], "global");
  assert.deepEqual(result.registered.map((item) => item.path), [repo]);
});

test("the dispatch home, missing folders and the home directory are not registered", async () => {
  writeRegistry([]);
  const result = await ensureProjects(layout, loaded(), [layout.home, path.join(temporary, "nope"), os.homedir()], "global");
  assert.deepEqual(result.registered, []);
  assert.equal(result.skipped.length, 3);
  assert.equal(registryFile().projects.length, 0);
});

test("a plain folder without git still gets a draft marked as such", async () => {
  const folder = path.join(temporary, "plain-notes");
  mkdirSync(folder);
  const scan = await scanProject(folder);
  assert.equal(scan.isGit, false);
  const doc = renderProjectDoc({ scan, statusDir: "/x/进度", docDir: "/x", date: "2026-11-24", name: "Notes" });
  assert.match(doc, /不是 Git 仓库/);
  assert.match(doc, /没认出来（待核对）/);
  assert.match(doc, /^## 提交$/m);
  assert.match(doc, /^## 部署$/m);
});
