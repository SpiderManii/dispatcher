const RECOMMENDATION = /[（(]\s*推荐\s*[：:]\s*([^）)]*)[）)]/;

/** 「问题（推荐：…）」 split so each shows on its own line. */
export function splitDecision(text: string): { question: string; recommendation: string | null } {
  const match = text.match(RECOMMENDATION);
  if (!match) return { question: text.trim(), recommendation: null };
  return { question: text.replace(match[0], "").trim() || text.trim(), recommendation: match[1].trim() || null };
}
