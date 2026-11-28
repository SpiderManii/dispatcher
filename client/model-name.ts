const EFFORT: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
const ACRONYMS = new Set(["gpt"]);
const SPELLED: Record<string, string> = { deepseek: "DeepSeek" };

export interface ModelName {
  name: string;
  /** Thinking level in Chinese; null when the config doesn't set one. */
  effort: string | null;
}

const word = (text: string) => {
  if (ACRONYMS.has(text)) return text.toUpperCase();
  if (SPELLED[text]) return SPELLED[text];
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Turns a config label into something readable: 「拆分（codex/gpt-6.1-sol high）」→ GPT 6.1 Sol, 高.
 * The provider is dropped unless it's all there is, since the model already says whose it is.
 */
export function modelName(label: string): ModelName {
  const inner = label.match(/（(.+)）$/)?.[1] ?? label;
  const [reference, thinking] = inner.trim().split(/\s+/);
  // Model IDs can carry their own prefix (`codex/auto/grok-4.7`); the last segment is the model.
  let model = reference.includes("/") ? reference.slice(reference.lastIndexOf("/") + 1) : reference;
  // Some providers take a route instead of a model: provider/["hub","vendor/model-name"]. The last hop names the model.
  const open = reference.indexOf("[");
  if (open >= 0) {
    try {
      const route = JSON.parse(reference.slice(open)) as unknown;
      const last = Array.isArray(route) ? route.filter((item): item is string => typeof item === "string").pop() : undefined;
      if (last) model = last.slice(last.lastIndexOf("/") + 1);
    } catch {
      // Not a route after all: shown as written.
    }
  }
  const suffix = model.match(/-(low|medium|high|xhigh|max)$/)?.[1];
  const bare = suffix ? model.slice(0, -suffix.length - 1) : model;
  const family = /^(sonnet|opus|haiku|fable)$/.test(bare) ? ["Claude"] : [];
  return {
    name: [...family, ...bare.split("-").filter(Boolean).map(word)].join(" "),
    effort: EFFORT[thinking ?? suffix ?? ""] ?? null,
  };
}
