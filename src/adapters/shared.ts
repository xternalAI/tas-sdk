import type { PromptDefinition, PromptTool } from "../prompt/model.ts";

/**
 * What every platform adapter needs and none should reinvent: an HTTP client with uniform error
 * handling, and the conversions between our tool and output definitions and the OpenAI shapes
 * that Braintrust and Langfuse store.
 */

/** A platform answered with an error, or could not represent something. `status` is set for HTTP failures. */
export class PlatformError extends Error {
  readonly platform: string;
  readonly status: number | undefined;
  constructor(platform: string, message: string, status?: number) {
    super(message);
    this.platform = platform;
    this.status = status;
  }
}

export interface HttpOptions {
  /** Used in error messages, e.g. "braintrust". */
  platform: string;
  /** Prepended to every path, without a trailing slash. */
  baseURL: string;
  /** Sent with every request, typically authentication. */
  headers: Record<string, string>;
  fetch?: typeof fetch | undefined;
  /** Build the error to throw. Lets each adapter keep its own error class. Default: `PlatformError`. */
  error?: (message: string, status?: number) => Error;
}

export interface RequestInput {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface Http {
  /** JSON in, JSON out. Throws on any non-2xx status. An empty reply body is `undefined`. */
  request<T>(method: string, path: string, input?: RequestInput): Promise<T>;
  /** As `request`, but a 404 is an answer ("not there") rather than an error, and returns `undefined`. */
  find<T>(method: string, path: string, input?: RequestInput): Promise<T | undefined>;
  /** The underlying fetch, for the rare call that is not JSON-over-`baseURL`. */
  fetch: typeof fetch;
}

export function createHttp(options: HttpOptions): Http {
  const doFetch = options.fetch ?? fetch;
  const fail = options.error ?? ((message: string, status?: number) => new PlatformError(options.platform, message, status));

  async function send<T>(method: string, path: string, input: RequestInput, notFoundIsEmpty: boolean): Promise<T | undefined> {
    const url = new URL(options.baseURL + path);
    for (const [key, value] of Object.entries(input.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await doFetch(url, {
      method,
      headers: { "content-type": "application/json", ...options.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    if (response.status === 404 && notFoundIsEmpty) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw fail(`${options.platform} ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    const text = await response.text(); // deletes answer with an empty body on some platforms
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    request: (method, path, input = {}) => send(method, path, input, false) as Promise<never>,
    find: (method, path, input = {}) => send(method, path, input, true),
    fetch: doFetch,
  };
}

/** A tool definition in the OpenAI chat format. */
export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export function toOpenAITools(tools: PromptTool[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters },
  }));
}

/** The reverse of `toOpenAITools`. `undefined` or an empty list gives `undefined`, since "no tools" has one spelling. */
export function fromOpenAITools(tools: OpenAITool[] | null | undefined): PromptTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(({ function: fn }) => ({
    name: fn.name,
    ...(fn.description ? { description: fn.description } : {}),
    parameters: fn.parameters ?? {},
  }));
}

type Output = NonNullable<PromptDefinition["output"]>;
/** The name used on the wire when an output schema has none. Read back as "no name", so it round-trips. */
const DEFAULT_OUTPUT_NAME = "output";

/** Our output contract as an OpenAI `response_format`. */
export function toResponseFormat(output: Output): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: output.name ?? DEFAULT_OUTPUT_NAME,
      schema: output.schema,
      ...(output.strict === undefined ? {} : { strict: output.strict }),
    },
  };
}

/**
 * Read an OpenAI `response_format`. A JSON-schema one becomes our output contract; any other kind
 * (such as `json_object`) is not an output contract and is returned as `other` for the caller to keep.
 */
export function fromResponseFormat(format: unknown): { output?: Output; other?: unknown } {
  if (format === undefined || format === null) return {};
  const schema = (format as { type?: string; json_schema?: { name?: string; schema?: Record<string, unknown>; strict?: boolean } })
    .json_schema;
  if ((format as { type?: string }).type !== "json_schema" || !schema) return { other: format };
  return {
    output: {
      ...(schema.name && schema.name !== DEFAULT_OUTPUT_NAME ? { name: schema.name } : {}),
      schema: schema.schema ?? {},
      ...(schema.strict === undefined ? {} : { strict: schema.strict }),
    },
  };
}
