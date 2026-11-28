// Whether a message the user typed to the dispatcher reads as an answer to an open 待拍板, so the dispatcher is only
// reminded to tick the ledger when there is something to tick. Deliberately loose on wording, strict on chatter:
// a plain question or a new task does not count.

const WORDS =
  /按推荐|照推荐|听推荐|就推荐|采纳|同意|确认|批准|通过|就这样|就按|按你说的|按这个|选\s*[①-⑩A-Za-z1-9一二三四五六七八九]|用\s*[①-⑩]|选项|方案\s*[①-⑩A-Za-z1-9一二三四五六七八九]|第\s*[1-9一二三四五六七八九]\s*[条个种]|[①-⑩]|已过时|不用了|不需要|不做了|先不做|先停|取消/;

/** A bare option, like 「1」「A」「①」「选2」, is an answer too. */
const BARE = /^\s*[（(]?[①-⑩A-Za-z1-9]{1,2}[)）.。]?\s*$/;

export function looksLikeAnswer(text: string): boolean {
  const message = text.trim();
  return message.length > 0 && (BARE.test(message) || WORDS.test(message));
}
