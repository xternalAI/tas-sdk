/**
 * Masking runs in-process, before any exporter sees data, so the same rules
 * apply whichever platform (or platforms) a client exports to.
 */

export interface MaskingConfig {
  /** Object keys whose values are replaced wholesale. Strings match case-insensitively. */
  keys?: (string | RegExp)[];
  /** Patterns replaced inside every string value. */
  patterns?: RegExp[];
  /** Last word: runs on every leaf after keys and patterns. */
  custom?: (value: unknown, path: string[]) => unknown;
  /** Defaults to "[REDACTED]". */
  replacement?: string;
}

export type Masker = <T>(value: T) => T;

export const pii = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  creditCard: /\b(?:\d[ -]?){13,19}\b/g,
  bearerToken: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
} as const;

export function createMasker(config: MaskingConfig | undefined): Masker {
  if (!config) return (value) => value;
  const replacement = config.replacement ?? "[REDACTED]";
  const keyMatchers = (config.keys ?? []).map((k) =>
    typeof k === "string" ? (key: string) => key.toLowerCase() === k.toLowerCase() : (key: string) => k.test(key),
  );
  // Global regexes carry lastIndex state; clone so callers' instances are never mutated.
  const patterns = (config.patterns ?? []).map((p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`));

  const walk = (value: unknown, path: string[], seen: WeakSet<object>): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const p of patterns) out = out.replace(p, replacement);
      return config.custom ? config.custom(out, path) : out;
    }
    if (value === null || typeof value !== "object") {
      return config.custom ? config.custom(value, path) : value;
    }
    if (seen.has(value)) return replacement;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)], seen));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = keyMatchers.some((m) => m(key)) ? replacement : walk(v, [...path, key], seen);
    }
    return out;
  };

  return <T>(value: T) => walk(value, [], new WeakSet()) as T;
}
