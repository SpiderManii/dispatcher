// Quota precheck for dispatch_work, read from a usage endpoint (`registry.quotaUrl`).
// Response: { data: [{ provider, windows: [{ name, used, remaining, resetsAt, pool? }] }] }, percentages 0–100.

export interface QuotaWindow {
  name: string;
  used: number;
  remaining: number;
  resetsAt?: string;
  pool?: string;
}
export interface QuotaEntry {
  provider: string;
  windows: QuotaWindow[];
}

/** Below this share left, a family still takes work but the dispatcher is told not to give it a long job. */
export const LOW_REMAINING = 30;

const DURATION = /^\d+\s*(?:minutes?|hours?|days?|weeks?)$/i;

/**
 * A window can be scoped to some models: a pool ("Gemini", "Claude & GPT") or a name part ("7 days · Fable").
 * Unscoped windows cover every model of the provider.
 */
function applies(window: QuotaWindow, model: string): boolean {
  const scope = window.pool ?? window.name.split("·").map((part) => part.trim()).find((part) => part && !DURATION.test(part));
  if (!scope) return true;
  const words = scope.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  return words.length === 0 || words.some((word) => model.toLowerCase().includes(word));
}

export function parseQuotas(body: unknown): QuotaEntry[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (typeof item?.provider !== "string" || !Array.isArray(item.windows)) return [];
    const windows = (item.windows as unknown[]).flatMap((window) => {
      const w = window as Partial<QuotaWindow>;
      return typeof w?.name === "string" && typeof w.used === "number" && typeof w.remaining === "number"
        ? [{ name: w.name, used: w.used, remaining: w.remaining, resetsAt: w.resetsAt, pool: w.pool }]
        : [];
    });
    return [{ provider: item.provider.toLowerCase(), windows }];
  });
}

/**
 * For one `provider/model` in a quota family: `blocked` when a window that covers it is used up (§4: ≥100% pauses
 * the family until reset), `low` when the tightest one has under 30% left. Both null when the family isn't tracked.
 */
export function quotaState(
  quotas: QuotaEntry[],
  family: string | null,
  model: string,
): { blocked: string | null; low: string | null } {
  const entry = family ? quotas.find((item) => item.provider === family) : undefined;
  if (!entry) return { blocked: null, low: null };
  const windows = entry.windows.filter((window) => applies(window, model));
  const full = windows.find((window) => window.used >= 100);
  if (full) return { blocked: `${family} 额度已用完（${full.name}${full.resetsAt ? `，${full.resetsAt} 重置` : ""}）`, low: null };
  const tightest = [...windows].sort((a, b) => a.remaining - b.remaining)[0];
  if (tightest && tightest.remaining < LOW_REMAINING)
    return { blocked: null, low: `${family} 剩余 ${Math.round(tightest.remaining)}%（${tightest.name}），不接长活` };
  return { blocked: null, low: null };
}
