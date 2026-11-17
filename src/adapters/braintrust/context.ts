/**
 * What the Braintrust capabilities share, built once per adapter instance: the options, the HTTP
 * client, the factory for the adapter's error class, and the lazy lookup of the project id.
 */
import { createHttp, type Http } from "../shared.ts";
import type { BraintrustOptions } from "./index.ts";

/** Builds the error to throw. Supplied by `index.ts`, so every part throws `BraintrustError` without importing it. */
export type ErrorFactory = (message: string, status?: number) => Error;

export interface BraintrustContext {
  options: BraintrustOptions;
  /** The API origin, without a trailing slash. */
  baseURL: string;
  /** Authenticated JSON requests against `baseURL`. Failures are thrown as `error(message, status)`. */
  http: Http;
  error: ErrorFactory;
  /** The project every call is scoped to. Looked up by name on first use, then remembered. */
  projectId(): Promise<string>;
}

/** Build the shared context. Nothing is requested until a capability first needs the project id. */
export function createContext(options: BraintrustOptions, error: ErrorFactory): BraintrustContext {
  const baseURL = (options.baseURL ?? "https://api.braintrust.dev").replace(/\/$/, "");
  const http = createHttp({
    platform: "braintrust",
    baseURL,
    headers: { authorization: `Bearer ${options.apiKey}` },
    fetch: options.fetch,
    error,
  });
  let project: Promise<string> | undefined;
  const projectId = () => (project ??= resolveProjectId(options, http, error));
  return { options, baseURL, http, error, projectId };
}

/** The configured project id, or the id of the project with the configured name. Never creates a project. */
async function resolveProjectId(options: BraintrustOptions, http: Http, error: ErrorFactory): Promise<string> {
  if (options.projectId) return options.projectId;
  if (!options.projectName) throw error("braintrust: set projectId or projectName");
  const found = await http.request<{ objects: { id: string }[] }>("GET", "/v1/project", {
    query: { project_name: options.projectName },
  });
  const id = found.objects[0]?.id;
  if (!id) {
    throw error(
      `braintrust: project "${options.projectName}" not found. Create it in Braintrust first; this adapter never creates projects.`,
    );
  }
  return id;
}
