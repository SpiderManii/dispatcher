export interface DocSection {
  /** 1 for `#`, 2 for `##`; the overview before the first heading counts as 1. */
  level: 1 | 2;
  /** Heading text as written, without the leading #. */
  title: string;
  /** Short enough for a tag. */
  label: string;
  /** The heading line and everything under it, up to the next section. */
  markdown: string;
}

/** A tag label: drop a trailing parenthetical note and cut long titles. */
export function sectionLabel(title: string): string {
  const bare = title.replace(/[（(][^）)]*[）)]\s*$/, "").trim() || title.trim();
  return bare.length > 16 ? `${bare.slice(0, 15)}…` : bare;
}

/**
 * Splits Markdown at its top two heading levels so a long file can be read one section at a time.
 * `#` inside a fenced code block is not a heading. Anything before the first heading becomes a 概览 section.
 * Fewer than two sections means the file isn't worth splitting: the caller then shows it whole.
 */
export function splitSections(markdown: string): DocSection[] {
  const sections: { level: 1 | 2; title: string; lines: string[] }[] = [];
  let fence: string | null = null;
  let current: { level: 1 | 2; title: string; lines: string[] } = { level: 1, title: "概览", lines: [] };
  for (const line of markdown.split("\n")) {
    const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (mark) {
      if (fence === null) fence = mark[0];
      else if (mark[0] === fence) fence = null;
    }
    const heading = fence === null ? line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      sections.push(current);
      current = { level: heading[1].length === 1 ? 1 : 2, title: heading[2], lines: [line] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return sections
    .filter((section) => section.lines.join("\n").trim() !== "")
    .map((section) => ({ level: section.level, title: section.title, label: sectionLabel(section.title), markdown: section.lines.join("\n").trim() }));
}

export interface DocGroup {
  title: string;
  label: string;
  /** The rules of this group, one card each. */
  cards: DocSection[];
}

const headingLine = /^#{1,2}\s/;

/** The section's text without its own heading line, which the card shows as its title. */
export function bodyOf(section: DocSection): string {
  const lines = section.markdown.split("\n");
  return (headingLine.test(lines[0] ?? "") ? lines.slice(1) : lines).join("\n").trim();
}

/**
 * Groups sections the way a reader thinks of them: every `#` heading is a group and its `##` headings are the cards in
 * it. A `#` heading with text of its own gets that text as its first card. A group that is only one short note
 * (a provenance line, say) is folded into the group after it instead of standing alone as a page.
 */
export function groupSections(sections: DocSection[]): DocGroup[] {
  const groups: DocGroup[] = [];
  // Generated files start with HTML comments; a card of only that is noise.
  const hasText = (section: DocSection) => bodyOf(section).replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
  for (const section of sections) {
    if (!hasText(section) && section.level === 2) continue;
    if (section.level === 1) {
      const group: DocGroup = { title: section.title, label: section.label, cards: [] };
      const body = bodyOf(section);
      if (hasText(section)) group.cards.push({ level: 2, title: section.title, label: section.label, markdown: body });
      groups.push(group);
    } else {
      if (groups.length === 0) groups.push({ title: "概览", label: "概览", cards: [] });
      groups[groups.length - 1].cards.push(section);
    }
  }
  const merged: DocGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const next = groups[i + 1];
    const small = group.cards.length === 1 && group.cards[0].markdown.length < 300;
    if (small && next) next.cards.unshift(...group.cards);
    else if (group.cards.length > 0) merged.push(group);
  }
  return merged;
}

/** "3. 模型分工" → number 3 and the title without it, for a badge. */
export function cardTitle(title: string): { number: string | null; text: string } {
  const match = title.match(/^(\d+)[.、)]\s*(.+)$/);
  return match ? { number: match[1], text: match[2] } : { number: null, text: title };
}

/** The first couple of lines as plain text, for a collapsed card. Comments are dropped; a table gets a count, not its cells. */
export function preview(markdown: string, max = 120): string {
  const lines: string[] = [];
  let tableRows = 0;
  let fenced = false;
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^#{1,6}\s/.test(raw)) continue;
    if (/^\s*\|/.test(raw)) {
      if (!/^\s*\|[\s:|-]+\|?\s*$/.test(raw)) tableRows += 1;
      continue;
    }
    const text = raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]+/g, "")
      .trim();
    if (text) lines.push(text);
    if (lines.join(" ").length >= max) break;
  }
  const joined = lines.join(" ");
  if (!joined && tableRows > 0) return `表格 · ${Math.max(0, tableRows - 1)} 行`;
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}
