// Open 待拍板 items the lane has outgrown, closed by the plugin so the user does not have to press 「已过时」.
// Only what the stage settles: once the requirement is finished nothing is left to decide, and a question that is
// only about a gate (合回 / 部署 / 推送) is moot once the lane is past that gate. Anything else is a judgment call that
// stays with the dispatcher (its finished-card notice already asks it to close what a result made moot).

import { STEPS, type Step } from "../shared/stages";
import type { OpenDecision } from "./core";

const GATES: readonly { step: Step; pattern: RegExp }[] = [
  { step: "合回", pattern: /合回|合入|合并|merge/i },
  { step: "部署", pattern: /部署|上线|deploy/i },
  { step: "推送", pattern: /推送|push|推到远[程端]/i },
];

const indexOf = (step: Step) => STEPS.indexOf(step);

/** Why the item is moot at this step, or null when it is still a live question. */
export function staleReason(text: string, step: Step): string | null {
  if (step === "完成") return "需求已完成，没有要再定的了";
  const mentioned = GATES.filter((gate) => gate.pattern.test(text));
  if (mentioned.length === 0) return null;
  if (mentioned.every((gate) => indexOf(gate.step) < indexOf(step))) return `已过了「${mentioned.map((gate) => gate.step).join("、")}」这一步`;
  return null;
}

/** The open items the stage has made moot, with the reason for each. */
export function staleDecisions(
  decisions: readonly OpenDecision[],
  stage: { step: Step } | null,
): { decision: OpenDecision; reason: string }[] {
  if (!stage) return [];
  const out: { decision: OpenDecision; reason: string }[] = [];
  for (const decision of decisions) {
    const reason = staleReason(decision.text, stage.step);
    if (reason) out.push({ decision, reason });
  }
  return out;
}
