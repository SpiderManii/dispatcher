// A provider that just failed a worker for want of capacity, a rate limit or a used-up allowance is skipped for a
// while, so the next card goes to the role's next candidate instead of failing the same way. The quota check only
// sees allowances the quota service reports; these errors come from the workers themselves.

export interface Cooldown {
  family: string;
  /** Epoch ms after which the family is offered again. */
  until: number;
  reason: string;
  at: number;
}

export const COOLDOWN_MS = 30 * 60_000;
/** A reset time further out than this is not trusted; the family comes back after this long anyway. */
export const MAX_COOLDOWN_MS = 6 * 60 * 60_000;
const USAGE_FALLBACK_MS = 60 * 60_000;

const CAPACITY = /no capacity available|\bUNAVAILABLE\b.*\b503\b|\(code 503\)|\b503 Service Unavailable|overloaded/i;
const RATE = /rate[ _-]?limit|\b429\b|too many requests|RESOURCE_EXHAUSTED/i;
const USAGE = /hit your [\w-]+ limit|usage limit|limit reached|quota (?:exceeded|exhausted)|out of credits/i;

/** The cooldown a worker's failure calls for, or null when the failure says nothing about the provider's capacity. */
export function cooldownFor(family: string | null, detail: string | null, now: number): Cooldown | null {
  if (!family || !detail) return null;
  const at = now;
  if (USAGE.test(detail)) {
    const reset = resetTime(detail, now);
    const until = reset !== null && reset - now <= MAX_COOLDOWN_MS ? reset : now + (reset !== null ? MAX_COOLDOWN_MS : USAGE_FALLBACK_MS);
    return { family, until, reason: "用量到上限", at };
  }
  if (CAPACITY.test(detail)) return { family, until: now + COOLDOWN_MS, reason: "报 503 没容量", at };
  if (RATE.test(detail)) return { family, until: now + COOLDOWN_MS, reason: "被限流", at };
  return null;
}

/** Keeps the live ones, the new one replacing an older entry for its family unless that one lasts longer. */
export function withCooldown(list: readonly Cooldown[], next: Cooldown, now: number): Cooldown[] {
  const live = list.filter((item) => item.until > now);
  const prior = live.find((item) => item.family === next.family);
  if (prior && prior.until >= next.until) return live;
  return [...live.filter((item) => item.family !== next.family), next];
}

export function activeCooldown(list: readonly Cooldown[], family: string | null, now: number): Cooldown | null {
  if (!family) return null;
  return list.find((item) => item.family === family && item.until > now) ?? null;
}

/** What the dispatch result says about a skipped candidate. */
export function cooldownReason(cooldown: Cooldown, zone?: string): string {
  const clock = (ms: number) =>
    new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, ...(zone ? { timeZone: zone } : {}) }).format(ms);
  return `${clock(cooldown.at)} 刚${cooldown.reason}，插件到 ${clock(cooldown.until)} 前自动跳过这一家`;
}

/**
 * "resets 6:50am (Europe/London)", the way Claude words it: the next time that wall clock comes round in that zone.
 * null when the text names no reset time, or a zone this runtime doesn't know.
 */
export function resetTime(detail: string, now: number): number | null {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+\/[A-Za-z_\/]+)\))?/i.exec(detail);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3]?.toLowerCase();
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = match[4] ?? "UTC";
  try {
    for (let days = 0; days <= 1; days += 1) {
      const day = wallDate(now + days * 86_400_000, zone);
      const at = zonedToUtc(day.year, day.month, day.day, hour, minute, zone);
      if (at > now) return at;
    }
  } catch {
    return null;
  }
  return null;
}

function wallDate(ms: number, zone: string): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function zoneOffset(ms: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffset(guess, zone);
  // Once more, in case the guess and the answer sit on different sides of a DST change.
  return guess - zoneOffset(first, zone);
}
