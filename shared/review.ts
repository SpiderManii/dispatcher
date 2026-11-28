// §9 of the rules: the changes that want one review before they are merged back. Shared by the server's check, the
// contracts and the page.

export const SENSITIVE_KINDS = ["迁移", "密钥", "鉴权", "接口格式"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

/** needed: no review yet; running: one is out; done: one finished; waived: the user said none is needed. */
export const REVIEW_STATES = ["needed", "running", "done", "waived"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
