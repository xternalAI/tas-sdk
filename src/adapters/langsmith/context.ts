/**
 * What the capabilities of one LangSmith adapter instance share, built once per `langsmith(options)`
 * call: the HTTP client for the REST API, the authentication headers and the options themselves.
 */
import { createHttp, type Http } from "../shared.ts";
import { LangSmithError, type LangSmithOptions } from "./index.ts";

export interface LangSmithContext {
  /**
   * JSON client rooted at `<origin>/api/v1`; its errors are `LangSmithError`s. The capabilities call
   * `find`, not `request`: a 404 comes back as undefined so callers can tell "not there" from "broken".
   */
  http: Http;
  /** The deployment's root URL, without a trailing slash or the API path. The trace endpoint hangs off it. */
  origin: string;
  /** Authentication for every call, REST or traces: the API key, and the workspace when one was named. */
  headers: Record<string, string>;
  options: LangSmithOptions;
}

/** Build the shared context for one adapter instance. */
export function createContext(options: LangSmithOptions): LangSmithContext {
  const origin = (options.baseURL ?? "https://api.smith.langchain.com").replace(/\/$/, "");
  const headers = {
    "x-api-key": options.apiKey,
    ...(options.workspaceId ? { "x-tenant-id": options.workspaceId } : {}),
  };
  const http = createHttp({
    platform: "langsmith",
    baseURL: `${origin}/api/v1`,
    headers,
    fetch: options.fetch,
    error: (message, status) => new LangSmithError(message, status),
  });
  return { http, origin, headers, options };
}
