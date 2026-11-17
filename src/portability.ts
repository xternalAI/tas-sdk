import { hasAttachments, type PromptDefinition } from "./prompt/model.ts";
import { extractPlaceholders, findNonPortable } from "./prompt/template.ts";

/**
 * What happens to a prompt on each platform, worked out from the prompt alone: no network, no
 * configuration. It answers "if I push this anywhere, what will not be stored the way I wrote it?"
 * and is what the studio and `tas prompts check` show next to a prompt.
 *
 * This file is the one place that states, per platform, which parts of a prompt are native and
 * which are emulated. Keep it in step with the adapters and with docs/decisions.md.
 */

export type PlatformName = "braintrust" | "langfuse" | "langsmith";
export const PLATFORMS: readonly PlatformName[] = ["braintrust", "langfuse", "langsmith"];

export interface PortabilityNote {
  /** Which platform this concerns, or "all" for a problem with the prompt itself. */
  platform: PlatformName | "all";
  /**
   * - error: cannot be pushed there (or anywhere) as it is.
   * - warning: pushes and round-trips, but behaves differently on that platform, for example in its playground.
   * - info: kept in metadata there rather than in a native field. Your code is unaffected.
   */
  level: "error" | "warning" | "info";
  message: string;
}

const LANGSMITH_HANDLE = /^[a-z][a-z0-9_-]*$/;

/** Every portability note for a prompt, most serious first. An empty list means it is native everywhere. */
export function checkPortability(def: PromptDefinition): PortabilityNote[] {
  const notes: PortabilityNote[] = [];
  const note = (platform: PortabilityNote["platform"], level: PortabilityNote["level"], message: string) =>
    notes.push({ platform, level, message });

  const parts = def.type === "chat" ? def.messages.flatMap((m) => ("content" in m && Array.isArray(m.content) ? m.content : [])) : [];
  const hasFiles = parts.some((part) => part.type === "file");
  const hasPlaceholders = extractPlaceholders(def).length > 0;

  // The prompt itself.
  const nonPortable = findNonPortable(def);
  if (nonPortable.length) {
    note(
      "all",
      "error",
      `Template syntax that is not portable: ${[...new Set(nonPortable)].join("  ")}. Only {{name}} and {{nested.path}} mean the same on every platform; rendering this prompt throws.`,
    );
  }

  // Braintrust.
  if (hasPlaceholders) note("braintrust", "info", "Placeholders are kept in metadata; Braintrust shows the prompt without them.");
  if (def.type === "text" && def.tools)
    note("braintrust", "info", "Tools on a text prompt are kept in metadata; Braintrust completion prompts have no tools.");
  if (def.model?.params)
    note(
      "braintrust",
      "info",
      "Braintrust drops settings the chosen model does not support (for example temperature on reasoning models); they are restored from metadata when read back.",
    );
  if (def.archived) note("braintrust", "info", 'The archived flag is kept in metadata and mirrored as an "archived" tag.');

  // Langfuse.
  if (hasAttachments(def)) {
    note(
      "langfuse",
      "warning",
      "Langfuse messages are text only: attachments are stored as markers in the text and kept in metadata. In the Langfuse playground this prompt runs without its attachments.",
    );
  }
  if (def.description) note("langfuse", "info", "The description is kept in metadata; a Langfuse prompt has no description field.");
  if (def.metadata) note("langfuse", "info", "Metadata is kept inside the prompt's config.");
  if (def.archived) note("langfuse", "info", 'The archived flag is kept in metadata and mirrored as an "archived" tag.');

  // LangSmith.
  const handle = def.name.replaceAll("/", "--");
  if (def.name.includes("--") || !LANGSMITH_HANDLE.test(handle)) {
    note(
      "langsmith",
      "error",
      `The name "${def.name}" cannot be stored: LangSmith names must start with a letter, and "--" is reserved for "/".`,
    );
  } else if (def.name.includes("/")) {
    note("langsmith", "info", `Stored as "${handle}": LangSmith names cannot contain "/".`);
  }
  if (def.tools && !def.model)
    note("langsmith", "warning", "Tools are kept in metadata only: LangSmith binds tools to a model, and this prompt names none.");
  if (def.output && def.type === "text")
    note(
      "langsmith",
      "warning",
      "The output schema is kept in metadata only: LangSmith has structured output for chat prompts, not text prompts.",
    );
  if (hasFiles)
    note(
      "langsmith",
      "warning",
      "File attachments are kept in metadata only: LangSmith has templates for text and images, not files. Its playground shows the prompt without them.",
    );
  if (def.model?.params)
    note(
      "langsmith",
      "info",
      "Only common settings (temperature, max_tokens, top_p, ...) become playground controls; other settings are kept in metadata.",
    );
  if (def.description || def.tags)
    note("langsmith", "info", "Description and tags are repo-wide in LangSmith; the per-version copy is kept in metadata.");
  if (def.archived) note("langsmith", "info", 'The archived flag is kept in metadata and mirrored as an "archived" tag.');

  const order = { error: 0, warning: 1, info: 2 };
  return notes.sort((a, b) => order[a.level] - order[b.level]);
}

/** The most serious level among a prompt's notes, or "ok" when there are none above info. */
export function portabilityLevel(notes: PortabilityNote[]): "error" | "warning" | "ok" {
  return notes.some((n) => n.level === "error") ? "error" : notes.some((n) => n.level === "warning") ? "warning" : "ok";
}
