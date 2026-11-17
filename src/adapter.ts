import { ARCHIVED_TAG, hashPrompt, type PromptDefinition, type PromptRef } from "./prompt/model.ts";
import type { TraceExporter } from "./trace.ts";

/**
 * How a platform handles one part of the canonical prompt.
 * - native: the platform has a first-class field for it.
 * - emulated: the adapter stores it in the platform's free-form metadata, inside
 *   the reserved envelope. It may look odd in the platform UI, but it round-trips.
 * - unsupported: cannot be stored at all; push must fail loudly rather than drop it.
 */
export type Support = "native" | "emulated" | "unsupported";

export interface PromptCapabilities {
  labels: Support;
  textPrompts: Support;
  placeholders: Support;
  modelConfig: Support;
  tools: Support;
  outputSchema: Support;
  tags: Support;
  metadata: Support;
  description: Support;
  nestedNames: Support;
  archived: Support;
}

export interface RemotePrompt {
  definition: PromptDefinition;
  /** Platform-opaque, immutable version id. */
  version: string;
  labels: string[];
}

export interface PushOptions {
  /** Labels to point at the new version. */
  labels?: string[];
  message?: string;
  /** Go ahead even where the adapter would refuse because the push loses something on the platform. */
  force?: boolean;
}

/**
 * The contract every adapter must honour, enforced by the conformance suite:
 *   (await get({ name, version: (await push(def)).version })).definition  deep-equals  def
 * for every definition the capabilities do not mark "unsupported".
 */
export interface PromptRegistry {
  capabilities: PromptCapabilities;
  /** Resolves `version` if given, else `label`, else the latest version. Null when the prompt or pointer does not exist. */
  get(ref: PromptRef): Promise<RemotePrompt | null>;
  list(): Promise<{ name: string; labels: string[] }[]>;
  /** Creates a new version. Must be a no-op returning the existing version when content is unchanged. */
  push(definition: PromptDefinition, options?: PushOptions): Promise<RemotePrompt>;
  /** Points each label at `version`, taking it from whichever version held it. Other labels are untouched. */
  setLabels(name: string, version: string, labels: string[]): Promise<void>;
  /** Permanently removes the prompt and every version of it. A no-op if it does not exist. Never called by sync. */
  delete(name: string): Promise<void>;
}

export interface PlatformAdapter {
  /** "langfuse", "langsmith", "braintrust", ... */
  id: string;
  prompts?: PromptRegistry;
  /** Where and how this platform takes traces. */
  tracing?: TraceExporter;
  // the evals contract lands with its phase.
}

/** Tags to store natively: the user's, plus the marker that makes an archived prompt filterable in the vendor UI. */
export function tagsWithArchiveMarker(definition: PromptDefinition): string[] {
  return [...(definition.tags ?? []), ...(definition.archived ? [ARCHIVED_TAG] : [])];
}

/** The inverse: the envelope says whether the prompt is archived; the tag is only a mirror of that. */
export function tagsWithoutArchiveMarker(tags: string[] | null | undefined, archived: boolean | undefined): string[] {
  return (tags ?? []).filter((t) => !(archived && t === ARCHIVED_TAG));
}

/** Reserved metadata key holding whatever a platform cannot represent natively. */
export const ENVELOPE_KEY = "__tas";

export interface Envelope {
  v: 1;
  hash: string;
  fields: Partial<PromptDefinition>;
}

/** Build the envelope for the fields this platform has to emulate. */
export function packEnvelope(
  definition: PromptDefinition,
  emulated: readonly (keyof PromptDefinition)[],
): Envelope {
  const fields: Record<string, unknown> = {};
  for (const key of emulated) {
    const value = (definition as unknown as Record<string, unknown>)[key];
    if (value !== undefined) fields[key] = value;
  }
  return { v: 1, hash: hashPrompt(definition), fields: fields as Partial<PromptDefinition> };
}

/** Read an envelope back out of platform metadata. Tolerates prompts created outside the SDK. */
export function unpackEnvelope(metadata: unknown): Envelope | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>)[ENVELOPE_KEY];
  if (!raw || typeof raw !== "object" || (raw as Envelope).v !== 1) return undefined;
  return raw as Envelope;
}
