/**
 * What the parts of one Langfuse adapter instance share, built once per `langfuse(options)` call:
 * the HTTP client, the base URL and the auth header. Also the paging loop every list call uses.
 */
import { createHttp, type Http } from "../shared.ts";
import { LangfuseError } from "./error.ts";
import type { LangfuseOptions } from "./index.ts";

export interface LangfuseContext {
  /** JSON client for the public API. The errors it throws are `LangfuseError`. */
  http: Http;
  /** The public API root, e.g. https://cloud.langfuse.com/api/public, without a trailing slash. */
  baseURL: string;
  /** The Basic auth header value made from the key pair. */
  authorization: string;
  /** The caller's `fetch`, if they passed one. `http.fetch` is this or the global one. */
  fetch: typeof fetch | undefined;
}

export function createContext(options: LangfuseOptions): LangfuseContext {
  const baseURL = (options.baseURL ?? "https://cloud.langfuse.com").replace(/\/$/, "") + "/api/public";
  const authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;
  const http = createHttp({
    platform: "langfuse",
    baseURL,
    headers: { authorization },
    fetch: options.fetch,
    error: (message, status) => new LangfuseError(message, status),
  });
  return { http, baseURL, authorization, fetch: options.fetch };
}

/** Every row of a paged Langfuse list, 100 per request, in the order served. A 404 ends the list. */
export async function allPages<T>(http: Http, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const pageQuery = { ...query, page: String(page), limit: "100" };
    const result = await http.find<{ data: T[]; meta: { totalPages: number } }>("GET", path, { query: pageQuery });
    rows.push(...(result?.data ?? []));
    if (!result || page >= result.meta.totalPages) return rows;
  }
}
