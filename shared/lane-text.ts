// How a lane reads: by its requirement, not by the projects it holds. Shared by the page and the sidebar summary. No imports.

const MAX = 32;
const ITEM = /(?:^|[\s；;。，,])(?:\d{1,2}|[一二三四五六七八九十])[.、．)）]\s*/g;

/**
 * The requirement as a card title: its first item or sentence, without the numbering, plus how many more items the
 * user listed. 「1.商品的列表页面需要修改；2.详情页优化」 → 「商品的列表页面需要修改 等 2 项」.
 */
export function requirementTitle(summary: string | null | undefined): string | null {
  const text = (summary ?? "").trim();
  if (!text) return null;
  const items = text.match(ITEM)?.length ?? 0;
  const first = text
    .split(/\r?\n|[；;。]/)
    .map((part) => part.replace(/^\s*(?:\d{1,2}|[一二三四五六七八九十])[.、．)）]\s*/, "").trim())
    .find((part) => part.length > 0);
  if (!first) return null;
  const head = [...first].length > MAX ? `${[...first].slice(0, MAX).join("")}…` : first;
  return items > 1 ? `${head} 等 ${items} 项` : head;
}

/**
 * The requirement a lane with several is on now: the newest one not done, else the last. Null for fewer than two,
 * when the lane reads by its summary as before.
 */
export function focusRequirement<T extends { done: boolean }>(items: readonly T[] | undefined): T | null {
  if (!items || items.length < 2) return null;
  return [...items].reverse().find((item) => !item.done) ?? items[items.length - 1];
}
