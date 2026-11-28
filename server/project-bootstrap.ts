// Fills in what a newly added project is missing: its registry entry and its PROJECT.md (项目说明).
// No Paseo imports, so it can be tested with plain Node.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonical, isInside, writeAtomic, type Layout, type ProjectDef, type Registry } from "./core";

const exec = promisify(execFile);

export const PROJECT_DOC_NOTE = "项目说明由插件按仓库内容自动生成（草稿），待核对";

export interface ProjectScan {
  /** Repository root. */
  root: string;
  name: string;
  isGit: boolean;
  branch: string | null;
  head: string | null;
  branches: string[];
  remotes: string[];
  dirtyCount: number | null;
  worktrees: string[];
  summary: string | null;
  stack: string[];
  commands: { start: string[]; verify: string[] };
  docs: string[];
  directories: string[];
  envFiles: string[];
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

async function git(directory: string, args: string[]): Promise<string | null> {
  try {
    const out = await exec("git", ["-C", directory, ...args], { env: gitEnv(), timeout: 5000, maxBuffer: 1024 * 1024 });
    return out.stdout;
  } catch {
    return null;
  }
}

/** Drops credentials from a remote URL, so a token in `https://user:token@host/…` never reaches a file. */
export function safeRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
}

/**
 * The repository root a picked folder belongs to. A linked worktree maps to its main repository; a folder outside any
 * repository, or inside one that is the home directory itself, is its own root.
 */
export async function repositoryRoot(folder: string): Promise<string> {
  const start = canonical(folder);
  const common = (await git(start, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
  if (!common) return start;
  const candidate = path.basename(common) === ".git" ? path.dirname(common) : null;
  if (!candidate) return start;
  const root = canonical(candidate);
  // A dotfiles repository in the home directory must not swallow every folder under it.
  if (isInside(root, os.homedir())) return start;
  return root;
}

function readText(file: string, limit = 64 * 1024): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, "utf8").slice(0, limit);
  } catch {
    return null;
  }
}

function readmeSummary(root: string): string | null {
  for (const name of ["README.md", "README.zh-CN.md", "README_CN.md", "readme.md", "README"]) {
    const text = readText(path.join(root, name), 16 * 1024);
    if (!text) continue;
    let title: string | null = null;
    const paragraph: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!title && /^#\s+/.test(line)) {
        title = line.replace(/^#\s+/, "").replace(/[*_`[\]]/g, "").trim();
        continue;
      }
      if (!line || /^(#|!\[|\[!\[|<|>|```|---|\|)/.test(line)) {
        if (paragraph.length > 0) break;
        continue;
      }
      paragraph.push(line);
      if (paragraph.join(" ").length > 240) break;
    }
    const body = paragraph.join(" ").replace(/\s+/g, " ").slice(0, 240).trim();
    const summary = [title, body].filter(Boolean).join("：");
    if (summary) return summary;
  }
  return null;
}

const NODE_STACK: [string, string][] = [
  ["vue", "Vue"],
  ["react", "React"],
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["svelte", "Svelte"],
  ["vite", "Vite"],
  ["element-plus", "Element Plus"],
  ["ant-design-vue", "Ant Design Vue"],
  ["antd", "Ant Design"],
  ["tailwindcss", "Tailwind CSS"],
  ["typescript", "TypeScript"],
  ["express", "Express"],
  ["@nestjs/core", "NestJS"],
  ["koa", "Koa"],
  ["prisma", "Prisma"],
  ["electron", "Electron"],
];

const PY_STACK: [RegExp, string][] = [
  [/\bfastapi\b/i, "FastAPI"],
  [/\bdjango\b/i, "Django"],
  [/\bflask\b/i, "Flask"],
  [/\bsqlalchemy\b/i, "SQLAlchemy"],
  [/\balembic\b/i, "Alembic"],
  [/\bpytest\b/i, "pytest"],
  [/\bpydantic\b/i, "Pydantic"],
];

function detectStack(root: string) {
  const stack: string[] = [];
  const start: string[] = [];
  const verify: string[] = [];
  const has = (name: string) => existsSync(path.join(root, name));

  const pkgText = readText(path.join(root, "package.json"));
  if (pkgText) {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(pkgText) as Record<string, unknown>;
    } catch {
      /* A broken package.json still means a Node project. */
    }
    const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, string>;
    const found = NODE_STACK.filter(([key]) => key in deps).map(([, label]) => label);
    stack.push(`Node（${manager}）${found.length ? `，${found.join("、")}` : ""}`);
    const engines = (pkg.engines as { node?: string } | undefined)?.node;
    if (engines) stack.push(`Node 版本要求 ${engines}`);
    const scripts = Object.keys((pkg.scripts as Record<string, string> | undefined) ?? {});
    const run = (script: string) => (manager === "npm" ? `npm run ${script}` : `${manager} ${script}`);
    for (const script of ["dev", "start", "serve"]) if (scripts.includes(script)) { start.push(run(script)); break; }
    for (const script of ["typecheck", "test", "build"]) if (scripts.includes(script)) verify.push(run(script));
  }
  const pyproject = readText(path.join(root, "pyproject.toml"));
  const requirements = readText(path.join(root, "requirements.txt"));
  if (pyproject || requirements || has("setup.py")) {
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`;
    const found = PY_STACK.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
    const manager = has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : has("Pipfile") ? "pipenv" : "pip";
    stack.push(`Python（${manager}）${found.length ? `，${found.join("、")}` : ""}`);
    if (found.includes("pytest") || has("tests") || has("test")) verify.push("pytest");
  }
  const goMod = readText(path.join(root, "go.mod"), 2048);
  if (goMod) {
    const version = /^go\s+(\S+)/m.exec(goMod)?.[1];
    stack.push(`Go${version ? ` ${version}` : ""}`);
    verify.push("go test ./...");
  }
  if (has("Cargo.toml")) {
    stack.push("Rust（cargo）");
    verify.push("cargo test");
  }
  if (has("pom.xml")) stack.push("Java（Maven）");
  if (has("build.gradle") || has("build.gradle.kts")) stack.push("Java/Kotlin（Gradle）");
  if (has("Dockerfile")) stack.push("有 Dockerfile");
  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yaml")) stack.push("有 docker compose 配置");
  return { stack, start, verify };
}

const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "dist", "build", "target", "venv", "coverage"]);

/** Reads the repository without running it. `.env*` files are only listed by name, never opened. */
export async function scanProject(folder: string): Promise<ProjectScan> {
  const root = canonical(folder);
  const isGit = existsSync(path.join(root, ".git"));
  const scan: ProjectScan = {
    root,
    name: path.basename(root) || root,
    isGit,
    branch: null,
    head: null,
    branches: [],
    remotes: [],
    dirtyCount: null,
    worktrees: [],
    summary: readmeSummary(root),
    stack: [],
    commands: { start: [], verify: [] },
    docs: [],
    directories: [],
    envFiles: [],
  };
  const detected = detectStack(root);
  scan.stack = detected.stack;
  scan.commands = { start: detected.start, verify: detected.verify };

  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    /* Unreadable folder: the draft just has less in it. */
  }
  scan.docs = ["PROJECT.md", "AGENTS.md", "CLAUDE.md", "README.md", "STATUS.md", "docs"].filter((name) => entries.includes(name));
  scan.envFiles = entries.filter((name) => /^\.env(\.|$)/.test(name));
  scan.directories = entries
    .filter((name) => !name.startsWith(".") && !SKIPPED_DIRS.has(name))
    .filter((name) => {
      try {
        return statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .slice(0, 12);

  if (isGit) {
    scan.branch = (await git(root, ["branch", "--show-current"]))?.trim() || null;
    scan.head = (await git(root, ["rev-parse", "--short=8", "HEAD"]))?.trim() || null;
    scan.branches = ((await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 10);
    const remotes = (await git(root, ["remote", "-v"])) ?? "";
    scan.remotes = [
      ...new Set(
        remotes
          .split("\n")
          .filter((line) => line.endsWith("(fetch)"))
          .map((line) => {
            const [name, url] = line.split(/\s+/);
            return `${name} ${safeRemote(url ?? "")}`;
          }),
      ),
    ];
    const status = await git(root, ["status", "--porcelain"]);
    scan.dirtyCount = status === null ? null : status.split("\n").filter(Boolean).length;
    scan.worktrees = ((await git(root, ["worktree", "list", "--porcelain"])) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((line) => canonical(line) !== root)
      .slice(0, 5);
  }
  return scan;
}

const tilde = (file: string) => {
  const home = os.homedir();
  return file === home ? "~" : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

/** The PROJECT.md draft. Anything it could not confirm is marked 待核对. */
export function renderProjectDoc(input: { scan: ProjectScan; statusDir: string; docDir: string; date: string; name: string }): string {
  const { scan } = input;
  const lines: string[] = [
    `# ${input.name}（${scan.name}）`,
    "",
    `> 草稿（${input.date}）：添加项目时由调度员插件按仓库内容自动生成，没有启动应用。标「待核对」的请用户确认后去掉标记。`,
    "",
    `- 本地仓库：${tilde(scan.root)}${scan.isGit ? "" : "（不是 Git 仓库）"}${
      scan.branch ? `，当前分支 \`${scan.branch}\`${scan.head ? `（${input.date} \`${scan.head}\`）` : ""}` : ""
    }。`,
  ];
  if (scan.isGit) {
    if (scan.branches.length > 0) lines.push(`- 本地分支：${scan.branches.join("、")}${scan.branches.includes("dev") ? "（有 dev，合回时按集成分支处理，待核对）" : ""}`);
    lines.push(`- 远程：${scan.remotes.length > 0 ? scan.remotes.join("；") : "没有配置"}。不 push、不删远程分支。`);
    if (scan.dirtyCount) lines.push(`- 主目录有 ${scan.dirtyCount} 项未提交改动，动手前先看清哪些是用户的，必须保留。`);
    if (scan.worktrees.length > 0) lines.push(`- 已有 worktree：${scan.worktrees.map(tilde).join("、")}`);
  }
  if (scan.summary) lines.push(`- 简介（取自 README）：${scan.summary}`);
  lines.push(`- 技术栈：${scan.stack.length > 0 ? scan.stack.join("；") : "没认出来（待核对）"}`);
  if (scan.directories.length > 0) lines.push(`- 顶层目录：${scan.directories.map((name) => `\`${name}/\``).join("、")}`);
  if (scan.docs.length > 0)
    lines.push(`- 仓库内说明：${scan.docs.map((name) => `\`${name}\``).join("、")}；worker 动手前先读，调度员不读。`);

  lines.push(
    "",
    "## 当前专项",
    "- 待核对：还没有专项记录。开第一条需求时，由调度员把分支和范围写在这里。",
    "",
    "## 运行与测试",
  );
  lines.push(scan.commands.start.length > 0 ? `- 启动：\`${scan.commands.start.join("`、`")}\`（待核对）` : "- 启动：待核对");
  lines.push(scan.commands.verify.length > 0 ? `- 验证：\`${scan.commands.verify.join("`、`")}\`（待核对）` : "- 验证：待核对");
  lines.push(
    "",
    "## 红线",
    "- 不 push、不部署，除非用户明确说。",
    scan.envFiles.length > 0
      ? `- \`${scan.envFiles.join("\`、\`")}\` 不读、不改、不打印；没有提交进版本库，必须保留。`
      : "- `.env*` 不读、不改、不打印。",
    "- 状态文件写进下面「路径」里的进度目录，不要写进仓库。",
    "",
    "## 提交",
    "- 身份：待核对。写成 `名字 <邮箱>` 后，任务卡的提交命令按它加 `git -c user.name=… -c user.email=…`；不写就用仓库现有的 git 配置。",
    "- 不入库的生成文件：待核对（如 `tsconfig.tsbuildinfo`，提交前还原）。",
    "",
    "## 部署",
    "- 待核对：不部署就写「不部署」。要部署的写服务名、步骤或手册路径、回滚方法；登记里还要有部署角色。",
    "",
    "## 路径",
    `- 状态文件：${tilde(input.statusDir)}/`,
    `- 决策记录：${tilde(path.join(input.docDir, "决策记录.md"))}（没有就新建）`,
    "",
  );
  return lines.join("\n");
}

function readJsonObject(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path.basename(file)} 不是 JSON 对象`);
  return value as Record<string, unknown>;
}

const safeSegment = (value: string) => value.replace(/[\\/:*?"<>|\0]/g, "-").replace(/^\.+/, "").trim() || "project";

/** Lowercase ASCII slug for the project ID; falls back to `project` for names with no usable characters. */
export function projectSlug(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(base)) base = base ? `p-${base}` : "project";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Where project folders live: next to the existing projects' PROJECT.md files, else under the dispatch home. */
export function projectsRoot(layout: Layout, registry: Registry): string {
  const counts = new Map<string, number>();
  for (const project of registry.projects) {
    if (!project.projectDoc) continue;
    const parent = path.dirname(path.dirname(canonical(project.projectDoc)));
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [parent, count] of counts)
    if (count > most) {
      best = parent;
      most = count;
    }
  return best ?? path.join(layout.home, "projects");
}

export interface BootstrapResult {
  /** Folders newly entered in registry.json. */
  registered: { id: string; path: string }[];
  /** Projects that got a PROJECT.md draft. */
  drafted: { id: string; doc: string }[];
  skipped: { path: string; reason: string }[];
}

/**
 * Makes each folder a registered project of `dispatcherId` with a PROJECT.md, where it lacks either.
 * Existing files are never overwritten, and projects of other dispatchers are left alone. `registry` is updated in
 * place and registry.json is rewritten with only the changed entries, so keys outside the schema survive.
 */
export async function ensureProjects(
  layout: Layout,
  registry: Registry,
  folders: readonly string[],
  dispatcherId: string,
  now: Date = new Date(),
): Promise<BootstrapResult> {
  const result: BootstrapResult = { registered: [], drafted: [], skipped: [] };
  const date = now.toISOString().slice(0, 10);
  const seen = new Set<string>();

  for (const picked of folders) {
    const folder = canonical(picked);
    if (seen.has(folder)) continue;
    seen.add(folder);
    const skip = (reason: string) => result.skipped.push({ path: folder, reason });
    try {
      if (!existsSync(folder) || !statSync(folder).isDirectory()) { skip("不是文件夹"); continue; }
      if (isInside(canonical(layout.home), folder)) { skip("是调度目录"); continue; }
      if (folder === canonical(os.homedir()) || folder === path.parse(folder).root) { skip("太宽，不当作项目"); continue; }

      const root = await repositoryRoot(folder);
      let project: ProjectDef | undefined = registry.projects.find((item) =>
        item.repos.some((repo) => canonical(repo) === root || isInside(canonical(repo), root)),
      );
      if (project && project.owner !== dispatcherId) { skip(`已登记给调度员 ${project.owner}`); continue; }
      const docMissing = project ? !project.projectDoc || !existsSync(canonical(project.projectDoc)) : true;
      if (project && !docMissing) continue;

      const scan = await scanProject(root);
      const isNew = !project;
      const takenIds = new Set(registry.projects.map((item) => item.id));
      const id = project?.id ?? projectSlug(scan.name, takenIds);
      const name = project?.name ?? scan.name;

      let docPath = project?.projectDoc ? canonical(project.projectDoc) : null;
      let statusDir = project?.statusDir ? canonical(project.statusDir) : null;
      if (!docPath) {
        const base = projectsRoot(layout, registry);
        const used = new Set(registry.projects.flatMap((item) => (item.projectDoc ? [path.dirname(canonical(item.projectDoc))] : [])));
        let dir = path.join(base, safeSegment(scan.name));
        if (used.has(dir)) dir = path.join(base, `${safeSegment(scan.name)}-${id}`);
        docPath = path.join(dir, "PROJECT.md");
        statusDir ??= path.join(dir, "进度");
      }
      const docDir = path.dirname(docPath);
      statusDir ??= path.join(docDir, "进度");

      // A PROJECT.md someone already wrote is linked, not replaced.
      let drafted = false;
      if (!existsSync(docPath)) {
        mkdirSync(docDir, { recursive: true });
        writeAtomic(docPath, renderProjectDoc({ scan, statusDir, docDir, date, name }));
        drafted = true;
      }
      mkdirSync(statusDir, { recursive: true });

      // Read-modify-write without an await in between, so concurrent callers cannot lose each other's entry.
      const raw = readJsonObject(layout.registryPath);
      const rawProjects = Array.isArray(raw.projects) ? (raw.projects as Record<string, unknown>[]) : [];
      const entry = rawProjects.find((item) => item.id === id);
      const note = drafted ? PROJECT_DOC_NOTE : undefined;
      if (entry) {
        entry.projectDoc = docPath;
        entry.statusDir ??= statusDir;
        if (note && !entry.note) entry.note = note;
      } else {
        rawProjects.push({
          id,
          name,
          owner: dispatcherId,
          repos: [root],
          projectDoc: docPath,
          statusDir,
          ...(note ? { note } : {}),
        });
      }
      raw.projects = rawProjects;
      writeAtomic(layout.registryPath, `${JSON.stringify(raw, null, 2)}\n`);

      if (project) {
        project.projectDoc = docPath;
        project.statusDir ??= statusDir;
        if (note && !project.note) project.note = note;
      } else {
        project = { id, name, owner: dispatcherId, repos: [root], projectDoc: docPath, statusDir, ...(note ? { note } : {}) };
        registry.projects.push(project);
      }
      if (isNew) result.registered.push({ id, path: root });
      if (drafted) result.drafted.push({ id, doc: docPath });
    } catch (error) {
      skip(`补齐失败：${(error as Error).message}`);
    }
  }
  return result;
}
