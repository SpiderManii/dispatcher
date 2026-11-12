// Advice on a task card's wording. It never rewrites the card: what the dispatcher wrote is what the worker gets,
// so acceptance can be checked against the card as written. No imports, so it can be tested on its own.

/** Above this the dispatcher is told to trim. Not a limit: a long card still goes out. */
export const CARD_LONG = 1500;

/** Short sentences that only restate 必守. Flagged, never removed: one may carry a SHA or a path the card needs. */
const RESTATES_MUST = [
  /^写完(状态文件)?就停[。.]?$/,
  /^(禁止|不要?)(再)?开子\s*agent[。.]?$/i,
];

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[。；;\n])/)
    .map((sentence) => sentence.replace(/^[\s\-*·\d.]+/, "").trim())
    .filter((sentence) => sentence.length >= 4);

/**
 * Said back to the dispatcher after a dispatch: how long the card ran, sentences that repeat 必守, and sentences
 * written word for word in more than one section. Null when there is nothing to say.
 */
export function cardFeedback(sections: Record<string, string | undefined>, prompt: string): string | null {
  const notes: string[] = [];
  const length = [...prompt].length;
  if (length > CARD_LONG) notes.push(`这张卡 ${length} 字，偏长（超过 ${CARD_LONG}）`);
  const restating = new Set<string>();
  const seenIn = new Map<string, Set<string>>();
  for (const [name, text] of Object.entries(sections)) {
    for (const sentence of sentencesOf(text ?? "")) {
      if (RESTATES_MUST.some((pattern) => pattern.test(sentence))) restating.add(sentence);
      seenIn.set(sentence, (seenIn.get(sentence) ?? new Set()).add(name));
    }
  }
  if (restating.size > 0) notes.push(`「必守」已有、不用再写：${[...restating].slice(0, 3).join(" ")}`);
  const repeated = [...seenIn].filter(([, names]) => names.size > 1);
  if (repeated.length > 0)
    notes.push(`同一句写在了几栏里：${repeated.slice(0, 3).map(([sentence, names]) => `「${sentence}」（${[...names].join("、")}）`).join("；")}`);
  if (notes.length === 0) return null;
  return `${notes.map((note) => note.replace(/[。.]+$/, "")).join("。")}。下次精简：「改与不改」最多 3 行只写范围，「其他」只写前面没有的。这张已照原文派出。`;
}

/** Appended to every card, so the dispatcher never has to write it. */
export function mustBlock(head: string | undefined): string {
  return [
    "## 必守",
    `- 首写前与提交前核 \`git rev-parse --show-toplevel\`、\`--abbrev-ref HEAD\`、HEAD SHA，与本卡的 cwd、预期分支${head ? "、预期 HEAD" : ""}不符立即停并上报。`,
    "- 黑名单：全仓 find；无路径 grep；node_modules、.next、tsbuildinfo、锁文件、构建产物；密钥与 .env 内容。",
    "- 写完状态文件就停。禁止再开子 agent。",
  ].join("\n");
}
