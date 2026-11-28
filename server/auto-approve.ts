/**
 * Dispatcher sessions run with tool calls approved for them, so the page isn't a wall of "allow this command?".
 * Only tool calls are approved: a question, a plan or a mode switch is the user's to answer. A few commands that
 * destroy work or leave the machine are not approved either; they are left pending for the user, not denied.
 */
const NEEDS_THE_USER: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+(checkout|restore)\s+(--\s|\.)/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+worktree\s+remove\b/i,
  /\bpaseo\s+(delete|project\s+delete)\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
];

export type ApprovalDecision = "allow" | "ask";

export function decideApproval(input: { kind: string; inDispatcherDir: boolean; text: string }): ApprovalDecision {
  if (!input.inDispatcherDir || input.kind !== "tool") return "ask";
  return NEEDS_THE_USER.some((pattern) => pattern.test(input.text)) ? "ask" : "allow";
}
