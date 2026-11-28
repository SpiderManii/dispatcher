// The pipeline a requirement goes through, and the words a ledger's 阶段 line may start with. No imports, so the server's
// pure modules, the contracts and the page all share one list.

export const STEPS = ["计划", "开发", "验收", "合回", "部署", "推送", "完成"] as const;
export type Step = (typeof STEPS)[number];

export const STAGE_WORDS = ["计划", "开发", "验收", "待合回", "合回中", "待部署", "部署中", "待推送", "已完成"] as const;
export type StageWord = (typeof STAGE_WORDS)[number];
