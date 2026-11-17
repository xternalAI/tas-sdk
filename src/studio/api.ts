import { rm } from "node:fs/promises";
import { createClient } from "../client.ts";
import type { TasConfig } from "../config.ts";
import { checkPortability, type PortabilityNote, portabilityLevel } from "../portability.ts";
import {
  listPromptNames,
  loadPrompts,
  parsePromptFile,
  promptPath,
  readPromptSource,
  stringifyPrompt,
  writePrompt,
} from "../prompt/file.ts";
import { PROMPT_NAME, type PromptDefinition, PromptValidationError } from "../prompt/model.ts";
import { extractPlaceholders, extractVariables, type RenderedMessage, renderPrompt } from "../prompt/template.ts";
import { pull, push, type SyncContext, status } from "../sync.ts";

/**
 * The studio's API: everything its page can do, as one function from a request to a response.
 * It works on the prompt files directly, so the studio and your editor are always looking at the
 * same thing, and it is the function the tests call. `server.ts` puts HTTP around it.
 */

export interface StudioContext {
  config: TasConfig;
  /** The prompts directory, absolute. */
  dir: string;
  /** The profile in use, which is also the lockfile section. */
  target: string;
}

export interface ApiRequest {
  method: string;
  /** Path and nothing else, e.g. "/api/prompts/support%2Ftriage". */
  path: string;
  body?: unknown;
}
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Everything the page shows about one prompt. `definition` is null while the file does not validate. */
export interface PromptDetail {
  name: string;
  /** The YAML as it would be saved, or the text being checked. */
  source: string;
  definition: PromptDefinition | null;
  /** Why the file is not valid. Empty when it is. */
  issues: string[];
  variables: string[];
  placeholders: string[];
  /** What each platform would not store natively. */
  notes: PortabilityNote[];
  level: "error" | "warning" | "ok";
}

/** A request the page got wrong, as opposed to a failure of ours. */
class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MODELINE = /^# yaml-language-server:.*\n/;

/** Validate YAML for a prompt and work out everything the page shows about it. Never throws. */
export function inspectPrompt(name: string, source: string): PromptDetail {
  const text = source.replace(MODELINE, "");
  try {
    const definition = parsePromptFile(text, name);
    const notes = checkPortability(definition);
    return {
      name,
      source: text,
      definition,
      issues: [],
      variables: extractVariables(definition),
      placeholders: extractPlaceholders(definition),
      notes,
      level: portabilityLevel(notes),
    };
  } catch (error) {
    const issues = error instanceof PromptValidationError ? error.issues : [error instanceof Error ? error.message : String(error)];
    return { name, source: text, definition: null, issues, variables: [], placeholders: [], notes: [], level: "error" };
  }
}

const STARTERS: Record<"chat" | "text", (name: string) => PromptDefinition> = {
  chat: (name) => ({
    type: "chat",
    name,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "{{input}}" },
    ],
  }),
  text: (name) => ({ type: "text", name, text: "{{input}}" }),
};

export function createStudioApi(ctx: StudioContext): (request: ApiRequest) => Promise<ApiResponse> {
  const registry = ctx.config.platform.prompts;
  const syncContext = (): SyncContext => {
    if (!registry) throw new ApiError(400, `platform "${ctx.config.platform.id}" has no prompt registry`);
    return { dir: ctx.dir, registry, platform: ctx.config.platform.id, canonical: ctx.config.canonical ?? "repo", target: ctx.target };
  };
  const requireName = (name: string) => {
    if (!PROMPT_NAME.test(name))
      throw new ApiError(400, `"${name}" is not a valid prompt name: use lowercase path segments such as "support/triage"`);
    return name;
  };
  const detail = async (name: string): Promise<PromptDetail> => {
    const source = await readPromptSource(ctx.dir, name);
    if (source === undefined) throw new ApiError(404, `no prompt "${name}"`);
    return inspectPrompt(name, source);
  };
  const field = <T>(body: unknown, key: string): T | undefined =>
    body && typeof body === "object" ? ((body as Record<string, unknown>)[key] as T | undefined) : undefined;

  const routes: Record<string, (request: ApiRequest, name: string) => Promise<unknown>> = {
    "GET /api/info": async () => ({
      platform: ctx.config.platform.id,
      canonical: ctx.config.canonical ?? "repo",
      promptsDir: ctx.dir,
      canSync: registry !== undefined,
      canRun: ctx.config.gateway !== undefined,
    }),

    "GET /api/prompts": async () => {
      const names = await listPromptNames(ctx.dir);
      return Promise.all(
        names.map(async (name) => {
          const d = await detail(name);
          return {
            name,
            type: d.definition?.type ?? null,
            description: d.definition?.description ?? null,
            archived: d.definition?.archived === true,
            valid: d.definition !== null,
            level: d.level,
          };
        }),
      );
    },

    "POST /api/prompts": async ({ body }) => {
      const name = requireName(String(field(body, "name") ?? ""));
      if ((await readPromptSource(ctx.dir, name)) !== undefined) throw new ApiError(409, `a prompt named "${name}" already exists`);
      await writePrompt(ctx.dir, STARTERS[field(body, "type") === "text" ? "text" : "chat"](name));
      return detail(name);
    },

    "GET /api/prompts/:name": async (_request, name) => detail(name),

    // Saving writes the file the way the SDK writes it: validated, keys in order, editor hint on the first line.
    "PUT /api/prompts/:name": async ({ body }, name) => {
      const checked = inspectPrompt(requireName(name), String(field(body, "source") ?? ""));
      if (!checked.definition) throw Object.assign(new ApiError(422, "the prompt is not valid"), { issues: checked.issues });
      await writePrompt(ctx.dir, checked.definition);
      return { ...checked, source: stringifyPrompt(checked.definition) };
    },

    "DELETE /api/prompts/:name": async (_request, name) => {
      await detail(name); // 404 when there is nothing to delete
      await rm(promptPath(ctx.dir, name));
      return { deleted: name };
    },

    // Checks text that has not been saved, so the page can validate as you type.
    "POST /api/check": async ({ body }) => inspectPrompt(String(field(body, "name") ?? "untitled"), String(field(body, "source") ?? "")),

    "POST /api/render": async ({ body }) => {
      const checked = inspectPrompt(String(field(body, "name") ?? "untitled"), String(field(body, "source") ?? ""));
      if (!checked.definition) throw Object.assign(new ApiError(422, "the prompt is not valid"), { issues: checked.issues });
      try {
        const messages = renderPrompt(checked.definition, {
          variables: field<Record<string, unknown>>(body, "variables") ?? {},
          placeholders:
            field<Record<string, RenderedMessage[]>>(body, "placeholders") ?? Object.fromEntries(checked.placeholders.map((p) => [p, []])),
        });
        return { messages };
      } catch (error) {
        throw new ApiError(422, (error as Error).message);
      }
    },

    "GET /api/status": async () =>
      (await status(syncContext())).map(({ name, state, error, nonPortable }) => ({
        name,
        state,
        ...(error ? { error } : {}),
        ...(nonPortable ? { nonPortable } : {}),
      })),

    "POST /api/push": async ({ body }) => {
      const names = field<string[]>(body, "names");
      const labels = field<string[]>(body, "labels");
      return push(syncContext(), {
        force: field(body, "force") === true,
        ...(names ? { only: names } : {}),
        ...(labels?.length ? { labels } : {}),
      });
    },

    "POST /api/pull": async ({ body }) => {
      const names = field<string[]>(body, "names");
      return pull(syncContext(), { force: field(body, "force") === true, ...(names ? { only: names } : {}) });
    },

    // Runs the saved prompt through the configured gateway. This makes a real, billable model call.
    "POST /api/run": async ({ body }) => {
      if (!ctx.config.gateway) throw new ApiError(400, "no gateway configured, so prompts cannot be run from the studio");
      const client = createClient({ ...ctx.config, prompts: await loadPrompts(ctx.dir), canonical: "repo", tracing: false });
      const name = String(field(body, "name") ?? "");
      const placeholders = Object.fromEntries((await detail(name)).placeholders.map((p) => [p, [] as RenderedMessage[]]));
      const result = await client.run(name, { variables: field<Record<string, unknown>>(body, "variables") ?? {}, placeholders });
      return { text: result.text, output: result.output ?? null, usage: result.usage, model: result.model, toolCalls: result.toolCalls };
    },
  };

  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    try {
      const [, name] = /^\/api\/prompts\/(.+)$/.exec(request.path) ?? [];
      const key = `${request.method} ${name ? "/api/prompts/:name" : request.path}`;
      const route = routes[key];
      if (!route) return { status: 404, body: { error: `no such route: ${request.method} ${request.path}` } };
      return { status: 200, body: await route(request, name ? decodeURIComponent(name) : "") };
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const issues = (error as { issues?: string[] }).issues;
      return { status, body: { error: error instanceof Error ? error.message : String(error), ...(issues ? { issues } : {}) } };
    }
  };
}
