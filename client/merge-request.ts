// The confirmation 「同意合回」 shows, the same on the page and in the panel beside a session.
import type { ConfirmRequest } from "./dialogs";

export interface LandingCheck {
  landings: { project: string; landing: string }[];
  unlanded: { project: string; branch: string; landing: string }[];
  toIntegrate: { project: string; landing: string; integration: string }[];
}

/** One click agrees to both: the lane's branches into its landing branch, then that into dev where there is one. */
export function mergeRequest(check: LandingCheck, agree: () => void, skipToDeploy: () => void): ConfirmRequest {
  const lines = [
    ...check.unlanded.map((entry) => `· 「${entry.project}」${entry.branch} → ${entry.landing}`),
    ...check.toIntegrate.map((entry) => `· 「${entry.project}」${entry.landing} → ${entry.integration}（本地合进 ${entry.integration}）`),
  ];
  if (lines.length === 0)
    return {
      title: "都已合好",
      message: `这条线的改动都已在收口分支（${check.landings.map((entry) => entry.landing).join("、") || "未定"}）上，有 dev 的也已合进 dev，不用再合。直接进入「待部署」？不需要部署的话，部署那一步点「不用部署」。`,
      confirmLabel: "进入待部署",
      onConfirm: skipToDeploy,
    };
  return {
    title: `同意这 ${lines.length} 处本地合并？`,
    message: `${lines.join("\n")}\n\n调度员先确认每个分支都已验收，再按顺序合并，每合一步跑一次回归，有冲突就停下报告。只在本机合，不推送、不部署。合完它会把阶段改成「待部署」。`,
    confirmLabel: "同意合回",
    onConfirm: agree,
  };
}
