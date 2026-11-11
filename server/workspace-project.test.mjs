import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { directoryWorkspaceSource } from "./workspace-project.ts";

let temporary;
let main;
let nested;
let external;
let unrelated;
let nestedRepository;
let plain;

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
  git(directory, "-c", "user.name=Project Selection Test", "-c", "user.email=test@example.invalid",
    "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fixture");
}

before(() => {
  temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "paseo-project-selection-")));
  main = path.join(temporary, "main");
  nested = path.join(main, ".worktrees", "sync-review");
  external = path.join(temporary, "external-review");
  unrelated = path.join(temporary, "unrelated");
  nestedRepository = path.join(main, "vendor", "different-repository");
  plain = path.join(temporary, "plain-directory");
  repository(main);
  git(main, "worktree", "add", "--detach", nested, "HEAD");
  git(main, "worktree", "add", "--detach", external, "HEAD");
  repository(unrelated);
  repository(nestedRepository);
  mkdirSync(path.join(main, "src"));
  mkdirSync(path.join(external, "src"));
  mkdirSync(path.join(plain, "subdirectory"), { recursive: true });
});
after(() => {
  assert.equal(path.dirname(temporary), realpathSync(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("paseo-project-selection-"));
  rmSync(temporary, { recursive: true, force: true });
});

function input(directory, overrides = {}) {
  const projectKey = "remote:example.invalid/same-repository";
  return {
    directory,
    dispatcherId: "dispatcher",
    registry: { projects: [{ id: "frontend", owner: "dispatcher", repos: [main] }] },
    laneProjects: [{ key: "frontend", name: "Frontend", path: main }],
    projects: [
      { projectId: "prj_sync_review", projectRootPath: nested, projectKey },
      { projectId: "prj_external", projectRootPath: external, projectKey },
      { projectId: "prj_unrelated", projectRootPath: unrelated, projectKey },
      { projectId: "prj_main", projectRootPath: main, projectKey },
    ],
    ...overrides,
  };
}

for (const [name, folder] of [
  ["main checkout", () => main],
  ["main checkout subdirectory", () => path.join(main, "src")],
  ["nested worktree", () => nested],
  ["external worktree", () => external],
  ["external worktree subdirectory", () => path.join(external, "src")],
]) {
  test(`${name}: selects only the main-root project and preserves cwd`, async () => {
    const directory = folder();
    assert.deepEqual(await directoryWorkspaceSource(input(directory)), {
      kind: "directory", path: directory, projectId: "prj_main",
    });
  });
}

test("a held external worktree is recognized through the same Git common directory", async () => {
  const result = await directoryWorkspaceSource(input(nested, {
    registry: { projects: [{ id: "frontend", owner: "dispatcher", repos: [external] }] },
    laneProjects: [{ key: "frontend", name: "Frontend", path: external }],
  }));
  assert.equal(result.projectId, "prj_main");
});

test("same remote key cannot substitute a worktree project when main registration is missing", async () => {
  const options = input(nested);
  options.projects = options.projects.filter((project) => project.projectId !== "prj_main");
  await assert.rejects(directoryWorkspaceSource(options), /主项目尚未在 Paseo 登记/);
});

test("duplicate main-root registrations fail instead of selecting an arbitrary project", async () => {
  const options = input(external);
  options.projects.push({ projectId: "prj_duplicate", projectRootPath: main });
  await assert.rejects(directoryWorkspaceSource(options), /主目录对应多个 Paseo 项目/);
});

for (const [name, folder] of [
  ["unrelated repository sharing a remote key", () => unrelated],
  ["unrelated repository physically inside the permitted checkout", () => nestedRepository],
  ["unrelated non-Git directory", () => plain],
]) {
  test(`${name} remains outside the lane's scope`, async () => {
    await assert.rejects(directoryWorkspaceSource(input(folder())), /工作目录不属于本会话线获准派单/);
  });
}

test("a registered repository not held by this lane is not authorized", async () => {
  await assert.rejects(directoryWorkspaceSource(input(main, { laneProjects: [] })), /工作目录不属于/);
});

test("a project owned by a different dispatcher is not authorized", async () => {
  await assert.rejects(directoryWorkspaceSource(input(main, { dispatcherId: "other-dispatcher" })), /工作目录不属于/);
});

test("explicitly assigned non-Git directory work keeps its registered directory project", async () => {
  const result = await directoryWorkspaceSource(input(path.join(plain, "subdirectory"), {
    registry: { projects: [] },
    laneProjects: [{ key: `dir:${plain}`, name: "Plain", path: plain }],
    projects: [{ projectId: "prj_plain", projectRootPath: plain }],
  }));
  assert.deepEqual(result, { kind: "directory", path: path.join(plain, "subdirectory"), projectId: "prj_plain" });
});
