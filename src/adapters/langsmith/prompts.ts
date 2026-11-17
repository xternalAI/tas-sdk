/**
 * The `PromptRegistry` for LangSmith: a prompt is a repo, a version is a commit holding a manifest,
 * and a label is a commit tag. This file makes the API calls; `manifest.ts` does the translation.
 */
import { ENVELOPE_KEY, tagsWithArchiveMarker } from "../../adapter.ts";
import type { PromptCapabilities, PromptRegistry, PushOptions, RemotePrompt } from "../../adapter.ts";
import { hashPrompt, parsePrompt, type PromptDefinition, type PromptRef } from "../../prompt/model.ts";
import type { LangSmithContext } from "./context.ts";
import { LangSmithError } from "./error.ts";
import type { Lc } from "./lc.ts";
import { decode, encode, toHandle, toName, type Repo } from "./manifest.ts";

interface Commit {
  commit_hash: string;
  manifest: Lc;
}
interface CommitTag {
  tag_name: string;
  commit_hash: string;
}

const CAPABILITIES: PromptCapabilities = {
  labels: "native", // commit tags
  textPrompts: "native",
  placeholders: "native",
  modelConfig: "native", // provider class + common settings; other settings ride in the envelope
  tools: "native", // when the prompt has a model to bind them to
  outputSchema: "native", // chat prompts only
  tags: "emulated",
  metadata: "emulated",
  description: "emulated",
  nestedNames: "emulated",
  archived: "emulated",
};

/** One commit of a repo, by hash, tag or "latest". Undefined when the repo or the pointer does not exist. */
function fetchCommit(ctx: LangSmithContext, handle: string, commitish: string): Promise<Commit | undefined> {
  // "-" is the owner placeholder for "the workspace this key belongs to".
  return ctx.http.find<Commit>("GET", `/commits/-/${handle}/${encodeURIComponent(commitish)}?include_model=true`);
}

/** Every commit tag of a repo, with the commit it points at. */
async function fetchTags(ctx: LangSmithContext, handle: string): Promise<CommitTag[]> {
  return (await ctx.http.find<CommitTag[]>("GET", `/repos/-/${handle}/tags`)) ?? [];
}

/** A commit as the registry returns it: decoded, with the labels that point at it. */
async function toRemote(ctx: LangSmithContext, handle: string, commit: Commit): Promise<RemotePrompt> {
  // Prompts never written by this SDK keep their description and tags on the repo only.
  const hasEnvelope = JSON.stringify(commit.manifest).includes(`"${ENVELOPE_KEY}"`);
  const [tags, repo] = await Promise.all([
    fetchTags(ctx, handle),
    hasEnvelope ? undefined : ctx.http.find<{ repo: Repo }>("GET", `/repos/-/${handle}`),
  ]);
  return {
    definition: decode(handle, commit.manifest, repo?.repo, ctx.options.resolveModel),
    version: commit.commit_hash,
    labels: tags.filter((t) => t.commit_hash === commit.commit_hash).map((t) => t.tag_name),
  };
}

/** Tag endpoints want the commit's UUID, which only the commit list exposes. */
async function commitId(ctx: LangSmithContext, handle: string, hash: string): Promise<string> {
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.http.find<{ commits: { id: string; commit_hash: string }[] }>("GET", `/commits/-/${handle}?limit=100&offset=${offset}`);
    const found = page?.commits.find((c) => c.commit_hash === hash);
    if (found) return found.id;
    if (!page || page.commits.length < 100) throw new LangSmithError(`langsmith: no version ${hash} of "${toName(handle)}"`);
  }
}

/** Point each label at the commit with UUID `id`: move the tag if the repo has it, create it otherwise. */
async function pointTags(ctx: LangSmithContext, handle: string, id: string, labels: string[]): Promise<void> {
  if (!labels.length) return;
  const existing = new Set((await fetchTags(ctx, handle)).map((t) => t.tag_name));
  for (const label of labels) {
    if (existing.has(label)) await ctx.http.find("PATCH", `/repos/-/${handle}/tags/${encodeURIComponent(label)}`, { body: { commit_id: id } });
    else await ctx.http.find("POST", `/repos/-/${handle}/tags`, { body: { tag_name: label, commit_id: id } });
  }
}

async function getPrompt(ctx: LangSmithContext, ref: PromptRef): Promise<RemotePrompt | null> {
  const handle = toHandle(ref.name);
  const commit = await fetchCommit(ctx, handle, ref.version ?? ref.label ?? "latest");
  return commit ? toRemote(ctx, handle, commit) : null;
}

/** Every private prompt repo of the workspace, with its commit tags as labels. */
async function listPrompts(ctx: LangSmithContext): Promise<{ name: string; labels: string[] }[]> {
  const out: { name: string; labels: string[] }[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.http.find<{ repos: Repo[]; total: number }>("GET", `/repos?is_public=false&limit=100&offset=${offset}`);
    for (const repo of page?.repos ?? []) {
      if (repo.repo_type && repo.repo_type !== "prompt") continue;
      out.push({ name: toName(repo.repo_handle), labels: repo.commit_tags ?? [] });
    }
    if (!page || offset + page.repos.length >= page.total || !page.repos.length) return out;
  }
}

/** Create the repo for a prompt that has no commit yet. */
async function createRepo(ctx: LangSmithContext, handle: string, repoFields: { description: string; tags: string[] }): Promise<void> {
  try {
    await ctx.http.find("POST", "/repos", { body: { repo_handle: handle, is_public: false, ...repoFields } });
  } catch (error) {
    if (!(error instanceof LangSmithError) || error.status !== 409) throw error; // exists, but has no commits yet
  }
}

/** Commit a new version. When the latest commit already reads back as the same prompt, only the labels move. */
async function pushPrompt(ctx: LangSmithContext, definition: PromptDefinition, pushOptions?: PushOptions): Promise<RemotePrompt> {
  const def = parsePrompt(definition);
  const handle = toHandle(def.name);
  const resolver = ctx.options.resolveModel;
  const manifest = encode(def, resolver);
  const labels = pushOptions?.labels ?? [];

  const latest = await fetchCommit(ctx, handle, "latest");
  const unchanged = latest && hashPrompt((await toRemote(ctx, handle, latest)).definition) === hashPrompt(decode(handle, manifest, undefined, resolver));
  if (latest && unchanged) {
    await pointTags(ctx, handle, labels.length ? await commitId(ctx, handle, latest.commit_hash) : "", labels);
    return toRemote(ctx, handle, latest);
  }

  const repoFields = { description: def.description ?? "", tags: tagsWithArchiveMarker(def) };
  if (!latest) await createRepo(ctx, handle, repoFields);
  // A repo with history rejects a commit that does not name its parent.
  const created = await ctx.http.find<{ commit: { id: string; commit_hash: string } }>("POST", `/commits/-/${handle}`, {
    body: { manifest, ...(latest ? { parent_commit: latest.commit_hash } : {}) },
  });
  if (!created) throw new LangSmithError(`langsmith: could not commit to "${handle}"`);
  // Mirror onto the repo so the prompt list in LangSmith reads sensibly; the envelope stays the source.
  if (latest) await ctx.http.find("PATCH", `/repos/-/${handle}`, { body: repoFields });
  await pointTags(ctx, handle, created.commit.id, labels);
  return { definition: def, version: created.commit.commit_hash, labels };
}

async function deletePrompt(ctx: LangSmithContext, name: string): Promise<void> {
  await ctx.http.find("DELETE", `/repos/-/${toHandle(name)}`); // removes the repo and every commit
}

async function setLabels(ctx: LangSmithContext, name: string, version: string, labels: string[]): Promise<void> {
  const handle = toHandle(name);
  await pointTags(ctx, handle, await commitId(ctx, handle, version), labels);
}

/** The prompt registry of one adapter instance. */
export function createPrompts(ctx: LangSmithContext): PromptRegistry {
  return {
    capabilities: { ...CAPABILITIES },
    get: (ref) => getPrompt(ctx, ref),
    list: () => listPrompts(ctx),
    push: (definition, pushOptions) => pushPrompt(ctx, definition, pushOptions),
    delete: (name) => deletePrompt(ctx, name),
    setLabels: (name, version, labels) => setLabels(ctx, name, version, labels),
  };
}
