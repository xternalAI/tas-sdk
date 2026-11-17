import type { PromptDefinition } from "./model.ts";

/**
 * The portable template subset: a variable is `{{name}}` or `{{nested.path}}`.
 * `{{{name}}}` and `{{&name}}` (mustache's "do not escape" forms) mean the same
 * thing here, since nothing is ever HTML-escaped.
 *
 * Everything else in double braces (sections, partials, filters, names with
 * hyphens), Nunjucks/Jinja blocks, and Langfuse prompt references are NOT
 * portable: the platforms disagree on them. They are never silently sent to a
 * model: rendering throws, and sync reports them.
 */

/** Any mustache tag: group 1 is the inside of `{{{ }}}`, group 2 the inside of `{{ }}`. */
const TAG = /\{\{\{([^{}]*)\}\}\}|\{\{([^{}]*)\}\}/g;
const PATH = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;
/** Constructs with no meaning in the portable subset: Nunjucks/Jinja blocks and comments, Langfuse composition. */
const FOREIGN = /\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|@@@langfusePrompt:[^@]*@@@/g;

export type RenderedMessage = { role: "system" | "user" | "assistant"; content: string };

export class TemplateError extends Error {}

/** The variable path a tag names, or undefined if the tag is not a plain variable. */
function variableOf(triple: string | undefined, double: string | undefined): string | undefined {
  const inner = (triple ?? double ?? "").trim();
  const path = triple === undefined && inner.startsWith("&") ? inner.slice(1).trim() : inner;
  return PATH.test(path) ? path : undefined;
}

function templateStrings(def: PromptDefinition): string[] {
  if (def.type === "text") return [def.text];
  return def.messages.flatMap((m) => ("content" in m ? [m.content] : []));
}

function scan(text: string): { variables: string[]; nonPortable: string[] } {
  const variables: string[] = [];
  const nonPortable: string[] = text.match(FOREIGN) ?? [];
  for (const match of text.matchAll(TAG)) {
    const variable = variableOf(match[1], match[2]);
    if (variable) variables.push(variable);
    else nonPortable.push(match[0]);
  }
  return { variables, nonPortable };
}

/** Variable names a prompt expects, in first-seen order. */
export function extractVariables(def: PromptDefinition): string[] {
  return [...new Set(templateStrings(def).flatMap((s) => scan(s).variables))];
}

/** Message-list slots a chat prompt expects. */
export function extractPlaceholders(def: PromptDefinition): string[] {
  if (def.type === "text") return [];
  return def.messages.flatMap((m) => ("placeholder" in m ? [m.placeholder] : []));
}

/** Template constructs that will not survive a move between platforms. Empty means portable. */
export function findNonPortable(def: PromptDefinition): string[] {
  return templateStrings(def).flatMap((s) => scan(s).nonPortable);
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function renderString(text: string, vars: Record<string, unknown>, promptName: string, strict: boolean): string {
  if (strict) {
    const { nonPortable } = scan(text);
    if (nonPortable.length) {
      throw new TemplateError(
        `prompt "${promptName}": cannot render ${nonPortable.map((t) => `"${t}"`).join(", ")}. ` +
          `Only {{variable}} and {{nested.path}} are supported; pass { strict: false } to send such text as written.`,
      );
    }
  }
  return text.replace(TAG, (tag, triple?: string, double?: string) => {
    const path = variableOf(triple, double);
    if (!path) return tag; // only reachable with strict: false
    const value = lookup(vars, path);
    if (value === undefined) throw new TemplateError(`prompt "${promptName}": missing variable "${path}"`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

export interface RenderInput {
  variables?: Record<string, unknown>;
  /** Messages for each `{ placeholder }` slot in a chat prompt. */
  placeholders?: Record<string, RenderedMessage[]>;
  /**
   * Default true: refuse to render a prompt containing template syntax outside the portable subset,
   * so it can never reach a model unrendered. Set false to pass such text through untouched.
   */
  strict?: boolean;
}

/** Render to plain chat messages. A text prompt becomes one user message. */
export function renderPrompt(def: PromptDefinition, input: RenderInput = {}): RenderedMessage[] {
  const vars = input.variables ?? {};
  const strict = input.strict ?? true;
  if (def.type === "text") {
    return [{ role: "user", content: renderString(def.text, vars, def.name, strict) }];
  }
  return def.messages.flatMap((m): RenderedMessage[] => {
    if ("placeholder" in m) {
      const filled = input.placeholders?.[m.placeholder];
      if (!filled) {
        throw new TemplateError(`prompt "${def.name}": missing placeholder "${m.placeholder}"`);
      }
      return filled;
    }
    return [{ role: m.role, content: renderString(m.content, vars, def.name, strict) }];
  });
}
