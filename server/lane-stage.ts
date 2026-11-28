// Where a lane's requirement stands: 计划 → 开发 → 验收 → 合回 → 部署 → 完成. The dispatcher keeps one `- 阶段：` line in
// the ledger; the plugin moves it when it knows better (a card of a given role went out, the user agreed to merge or
// deploy). Pure text logic, so it can be tested on its own.

import { STAGE_WORDS, STEPS, type StageWord, type Step } from "../shared/stages";

export { STAGE_WORDS, STEPS, type StageWord, type Step };

export interface LaneStage {
  step: Step;
  /** The next move is the user's: agree to merge, deploy, archive, or unblock. */
  waiting: boolean;
  /** The word as the ledger has it, or the plugin's guess. */
  word: string;
  /** What followed the word on the line. */
  note: string | null;
  source: "ledger" | "derived";
}

const LOOK: Record<StageWord, { step: Step; waiting: boolean }> = {
  计划: { step: "计划", waiting: false },
  开发: { step: "开发", waiting: false },
  验收: { step: "验收", waiting: false },
  待合回: { step: "合回", waiting: true },
  合回中: { step: "合回", waiting: false },
  待部署: { step: "部署", waiting: true },
  部署中: { step: "部署", waiting: false },
  待推送: { step: "推送", waiting: true },
  已完成: { step: "完成", waiting: true },
};

/**
 * Dispatchers wrote stage lines before there was a vocabulary («**准备归档**。两条分支已进 dev 并随 … 部署»), so the
 * earliest of these words on the line decides: the headline comes first. Bare 「完成」 is left out, as in 「开发完成」 it
 * means the step before.
 */
const SYNONYMS: [string, StageWord][] = [
  ["待合回", "待合回"],
  ["待收口", "待合回"],
  ["待合并", "待合回"],
  ["等合回", "待合回"],
  ["合回中", "合回中"],
  ["收口中", "合回中"],
  ["合并中", "合回中"],
  ["正在合回", "合回中"],
  ["正在收口", "合回中"],
  ["待部署", "待部署"],
  ["等部署", "待部署"],
  ["可部署", "待部署"],
  ["部署中", "部署中"],
  ["正在部署", "部署中"],
  ["上线中", "部署中"],
  ["待推送", "待推送"],
  ["等推送", "待推送"],
  ["待 push", "待推送"],
  ["待push", "待推送"],
  ["已完成", "已完成"],
  ["已部署", "已完成"],
  ["已上线", "已完成"],
  ["准备归档", "已完成"],
  ["可归档", "已完成"],
  ["待归档", "已完成"],
  ["验收", "验收"],
  ["测试", "验收"],
  ["审查", "验收"],
  ["核验", "验收"],
  ["联调", "验收"],
  ["开发", "开发"],
  ["施工", "开发"],
  ["返修", "开发"],
  ["实现", "开发"],
  ["修复", "开发"],
  ["计划", "计划"],
  ["拆分", "计划"],
  ["预检", "计划"],
  ["方案", "计划"],
  ["架构", "计划"],
  ["分诊", "计划"],
  ["开工", "计划"],
  ["合回", "合回中"],
  ["收口", "合回中"],
  ["部署", "部署中"],
  ["上线", "部署中"],
];

/** Said on the line, whatever the stage: the dispatcher is stuck on something only the user can do. */
const BLOCKED = /阻塞|卡住|等用户|等你/;

const STAGE_LINE = /^\s*[-*]\s*阶段[^：:\n]{0,30}[：:]\s*(.+)$/;
const ACCEPTANCE_LINE = /^\s*[-*]\s*验收口径[^：:\n]{0,20}[：:]\s*(.+)$/;
const NEXT_LINE = /^\s*[-*]\s*下一步[^：:\n]{0,30}[：:]\s*(.+)$/;
const plain = (text: string) => text.replace(/\*\*|__|`/g, "").trim();

function firstLine(ledger: string, pattern: RegExp): { index: number; text: string } | null {
  const lines = ledger.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) return { index, text: plain(match[1]) };
  }
  return null;
}

/** The earliest stage word in a text, the longer synonym winning a tie. */
function matchWord(text: string): { at: number; length: number; word: StageWord } | null {
  let best: { at: number; length: number; word: StageWord } | null = null;
  for (const [synonym, word] of SYNONYMS) {
    const at = text.indexOf(synonym);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && synonym.length > best.length)) best = { at, length: synonym.length, word };
  }
  return best;
}

/** The ledger's own 阶段 line, read leniently. Null when there is none or no word on it means anything. */
export function parseStage(ledger: string): LaneStage | null {
  const found = firstLine(ledger, STAGE_LINE);
  if (!found) return null;
  const text = found.text;
  const best = matchWord(text);
  if (!best) return null;
  const look = LOOK[best.word];
  const note = text
    .slice(best.at + best.length)
    .replace(/^[\s。，,；;：:）)（(—-]+/, "")
    .replace(/[）)]$/, "")
    .trim();
  return {
    step: look.step,
    waiting: look.waiting || BLOCKED.test(text),
    word: best.word,
    note: note ? note.slice(0, 160) : null,
    source: "ledger",
  };
}

export const REQUIREMENTS_HEADING = "## 需求清单";
const REQUIREMENT_LINE = /^\s*[-*]\s*(R\d+)\s*[【\[]\s*([^】\]]*?)\s*[】\]]\s*(.+?)\s*$/;
const NEED_LINE = /^\s*[-*]\s*需求[^：:\n]{0,10}[：:]\s*(.+)$/;

export interface Requirement {
  id: string;
  text: string;
  /** The stage word in its brackets; null when none is recognised. */
  word: StageWord | null;
  done: boolean;
  /** Made up from the ledger's head (需求 + 阶段) because it has no 需求清单: a lane holding a single requirement. */
  synthetic: boolean;
}

/**
 * The requirements a lane holds, in order: `- R2【开发】一句话` lines under 需求清单. A ledger without that list holds
 * one requirement, read from its 需求 and 阶段 lines, so older lanes look exactly as before.
 */
export function parseRequirements(ledger: string): Requirement[] {
  const lines = ledger.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === REQUIREMENTS_HEADING);
  const listed: Requirement[] = [];
  if (heading >= 0) {
    for (let index = heading + 1; index < lines.length && !/^##\s/.test(lines[index]); index += 1) {
      const match = REQUIREMENT_LINE.exec(lines[index]);
      if (!match) continue;
      const word = matchWord(plain(match[2]))?.word ?? null;
      listed.push({ id: match[1], text: plain(match[3]).slice(0, 200), word, done: word === "已完成", synthetic: false });
    }
  }
  if (listed.length > 0) return listed;
  const need = firstLine(ledger, NEED_LINE);
  if (!need?.text) return [];
  const word = parseStage(ledger)?.word as StageWord | undefined;
  return [{ id: "R1", text: need.text.slice(0, 200), word: word ?? null, done: word === "已完成", synthetic: true }];
}

/**
 * Sets one requirement's stage word in its 需求清单 line. Null when the list has no such line (a lane holding one
 * requirement keeps its stage on the 阶段 line instead).
 */
export function withRequirementWord(ledger: string, id: string, word: StageWord): string | null {
  const lines = ledger.split("\n");
  const heading = lines.findIndex((line) => line.trim() === REQUIREMENTS_HEADING);
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length && !/^##\s/.test(lines[index]); index += 1) {
    const match = REQUIREMENT_LINE.exec(lines[index]);
    if (!match || match[1] !== id) continue;
    lines[index] = lines[index].replace(/[【\[][^】\]]*[】\]]/, `【${word}】`);
    return lines.join("\n");
  }
  return null;
}

/** A requirement's word as a stage, so the dispatch rules that move the 阶段 line can move its line too. */
export function requirementStage(requirement: Pick<Requirement, "word">): LaneStage | null {
  return requirement.word ? parseStage(`- 阶段：${requirement.word}`) : null;
}

/** Stage words where a requirement is verified and waits on the user, or on the merge / deploy the user started. */
export const PAST_ACCEPTANCE: readonly string[] = ["待合回", "合回中", "待部署", "部署中", "待推送"];

/**
 * Which requirement a card works on. Required once two or more are open, so their merges, deploys and pushes can be
 * told apart; a lane holding one needs none (null). A building card may not write a landing branch while another
 * requirement, verified, waits to be merged, deployed or pushed: the two would ship together.
 */
export function requirementForCard(
  requirements: readonly Requirement[],
  card: {
    req?: string;
    roleId: string;
    branch: string;
    landings: readonly string[];
    /** The dispatcher's turn was opened by something the user typed, not by a plugin notice. */
    typedByUser?: boolean;
  },
): { req: string | null } | { problem: string } {
  const building = stepForRole(card.roleId) === "开发";
  // What the user typed may be a new requirement or rework on one: only the dispatcher can say, and it has to say so
  // before the card goes out, or the worker can never be told apart at 合回.
  if (building && card.typedByUser && !card.req)
    return {
      problem:
        "这张开发卡是因为用户在对话里说的话派的，要填 req 说明它属于哪个需求：是新需求，先在台账「需求清单」加一行（清单还空着，先把头部「需求：」那项记成 R1），再填新编号；是已有需求的返工、补充或修正，填那一项的编号（清单还空着就填 R1）。拿不准按返工。",
    };
  const listed = requirements.filter((item) => !item.synthetic);
  if (listed.length === 0) {
    if (card.req && card.req !== "R1")
      return { problem: `台账「需求清单」还是空的，没有 ${card.req}：先把头部「需求：」那项记成 R1、新需求记成 ${card.req}，再派` };
    return { req: null };
  }
  if (card.req && !listed.some((item) => item.id === card.req))
    return { problem: `台账「需求清单」里没有 ${card.req}（有 ${listed.map((item) => item.id).join("、")}）` };
  const open = listed.filter((item) => !item.done);
  if (!card.req && open.length >= 2)
    return {
      problem: `「需求清单」里有 ${open.length} 项没做完（${open.map((item) => `${item.id} ${item.text.slice(0, 20)}`).join("；")}），任务卡要填 req 说明这张做的是哪一项。`,
    };
  const req = card.req ?? open[0]?.id ?? listed[listed.length - 1].id;
  if (!building || !card.landings.includes(card.branch)) return { req };
  const waiting = listed.filter((item) => item.id !== req && PAST_ACCEPTANCE.includes(item.word ?? ""));
  if (waiting.length === 0) return { req };
  return {
    problem: [
      `${waiting.map((item) => `${item.id}【${item.word}】`).join("、")} 已验收，在等用户合回、部署或推送；${req} 的开发卡不能直接写收口分支 ${card.branch}，不然两项的提交会一起合回、上线。`,
      `从 ${card.branch} 拉 \`${card.branch}-${req}\` 单独建 worktree，任务卡的预期分支写它；${waiting.map((item) => item.id).join("、")} 收完之后，再把它合回 ${card.branch}。`,
    ].join("\n"),
  };
}

const BY_RECOMMENDATION = /^\s*[-*]\s*按推荐[：:]\s*(.+)$/;

/**
 * What the dispatcher decided for the user without asking: its `- 按推荐：问题 → 做法` lines, in ledger order. The
 * total, and the last `limit` of them.
 */
export function parseByRecommendation(ledger: string, limit = 5): { count: number; recent: string[] } {
  const found = ledger
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = BY_RECOMMENDATION.exec(line);
      const text = match ? plain(match[1]) : "";
      return text ? [[...text].length > 120 ? `${[...text].slice(0, 120).join("")}…` : text] : [];
    });
  return { count: found.length, recent: found.slice(-limit) };
}

/** The ledger's 验收口径 line, the user's own words for done. */
export function parseAcceptance(ledger: string): string | null {
  const found = firstLine(ledger, ACCEPTANCE_LINE);
  return found && found.text ? found.text.slice(0, 300) : null;
}

/** The ledger's lane-level 下一步 line (table cells don't count). */
export function parseNext(ledger: string): string | null {
  const found = firstLine(ledger, NEXT_LINE);
  return found && found.text ? found.text.slice(0, 200) : null;
}

/** Adds a line to the list under the ledger's title (after 项目/需求), or makes that list. */
function withHeaderLine(lines: string[], line: string): string[] {
  const firstSection = lines.findIndex((item) => /^##\s/.test(item));
  const head = firstSection < 0 ? lines.length : firstSection;
  let lastItem = -1;
  for (let index = 0; index < head; index += 1) if (/^\s*[-*]\s/.test(lines[index])) lastItem = index;
  const out = [...lines];
  if (lastItem >= 0) out.splice(lastItem + 1, 0, line);
  else out.splice(head, 0, line, "");
  return out;
}

/**
 * Sets the 阶段 line: replaces the one there, or adds it to the list under the ledger's title (after 项目/需求).
 * The old line's narrative goes: it described the stage being left.
 */
export function withStage(ledger: string, word: StageWord, note?: string): string {
  const line = `- 阶段：${word}${note ? `（${note}）` : ""}`;
  const lines = ledger.split("\n");
  const existing = lines.findIndex((item) => STAGE_LINE.test(item));
  if (existing >= 0) {
    lines[existing] = line;
    return lines.join("\n");
  }
  return withHeaderLine(lines, line).join("\n");
}

const oneLine = (text: string | null | undefined) =>
  (text ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("；");

/** The ledger's 验收口径 line for the user's own words, on one line. Null when there are none. */
export function acceptanceLine(acceptance: string | null | undefined): string | null {
  const text = oneLine(acceptance);
  return text ? `- 验收口径：${text}` : null;
}

/** Records a 验收口径 the user gave later: appended to the line there, as the first one still holds. */
export function withAcceptance(ledger: string, acceptance: string | null | undefined): string {
  const text = oneLine(acceptance);
  if (!text) return ledger;
  const lines = ledger.split("\n");
  const existing = lines.findIndex((item) => ACCEPTANCE_LINE.test(item));
  if (existing >= 0) {
    if (lines[existing].includes(text)) return ledger;
    lines[existing] = `${lines[existing].trimEnd()}；补充：${text}`;
    return lines.join("\n");
  }
  return withHeaderLine(lines, `- 验收口径：${text}`).join("\n");
}

const ROLE_STEP: Record<string, Step> = {
  split: "计划",
  architect: "计划",
  backend: "开发",
  frontend: "开发",
  design: "开发",
  test: "验收",
  review: "验收",
};

/** The step a card of this role works in; null for roles that say nothing about it (deploy also does local ops). */
export function stepForRole(role: string): Step | null {
  return ROLE_STEP[role] ?? null;
}

/** Words where the lane waits on the user to merge, deploy, push or archive: a new 开发 card reopens the work. */
const REOPENED_BY_BUILD: readonly string[] = ["待合回", "待部署", "待推送", "已完成"];

/**
 * What a dispatched card does to the stage. Moves within 计划 / 开发 / 验收, both ways (a fix during 验收 is 开发
 * again). Past 验收 it stays, except that a building card (开发) sent while the lane waits to be merged, deployed,
 * pushed or archived means new work — the next requirement in the same conversation, or rework — so the lane is back
 * in 开发 and the page stops offering to merge or archive half-done work. 合回中 / 部署中 are the user's clicks in
 * flight and are never moved.
 */
export function stageAfterDispatch(current: LaneStage | null, role: string): StageWord | null {
  const target = stepForRole(role);
  if (!target) return null;
  if (current && !(["计划", "开发", "验收"] as Step[]).includes(current.step))
    return target === "开发" && REOPENED_BY_BUILD.includes(current.word) ? "开发" : null;
  if (current?.step === target) return null;
  return target as StageWord;
}

/** A guess for ledgers without a 阶段 line: from what is running now, or 计划 when nothing ever went out. */
export function deriveStage(runningRoles: readonly (string | null)[], dispatchedEver: boolean): LaneStage | null {
  const steps = runningRoles.map((role) => (role === "deploy" ? ("部署" as Step) : role ? stepForRole(role) : null));
  const latest = steps
    .filter((step): step is Step => step !== null)
    .sort((a, b) => STEPS.indexOf(b) - STEPS.indexOf(a))[0];
  if (latest) return { step: latest, waiting: false, word: latest, note: null, source: "derived" };
  if (!dispatchedEver) return { step: "计划", waiting: false, word: "计划", note: null, source: "derived" };
  return null;
}

/** Adds a line at the top of 最近完成, making the section when an older ledger has none. */
export function withRecentDone(ledger: string, line: string): string {
  const lines = ledger.split("\n");
  const heading = lines.findIndex((item) => item.trim() === "## 最近完成");
  if (heading < 0) return `${ledger.replace(/\n*$/, "")}\n\n## 最近完成\n\n${line}\n`;
  let at = heading + 1;
  while (at < lines.length && lines[at].trim() === "") at += 1;
  lines.splice(at, 0, line);
  if (at === heading + 1) lines.splice(at, 0, "");
  return lines.join("\n");
}
