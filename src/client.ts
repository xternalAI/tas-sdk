import { AsyncLocalStorage } from "node:async_hooks";
import type { TasConfig } from "./config.ts";
import { createMasker, type Masker } from "./masking.ts";
import { hashPrompt, parsePrompt, type PromptDefinition, type ResolvedPrompt } from "./prompt/model.ts";
import { renderPrompt, type RenderedMessage, type RenderInput } from "./prompt/template.ts";

export class PromptNotFoundError extends Error {}
export class PromptArchivedError extends Error {}

export interface GetPromptOptions {
  version?: string;
  label?: string;
  /** Return a prompt even if it is archived. Default false: archived prompts throw. */
  allowArchived?: boolean;
}

export interface TasClient {
  readonly config: TasConfig;
  /** This client's masking rules. Applied to everything that leaves the process. */
  readonly mask: Masker;
  readonly prompts: {
    get(name: string, options?: GetPromptOptions): Promise<ResolvedPrompt>;
    render(
      name: string,
      input?: RenderInput,
      options?: GetPromptOptions,
    ): Promise<{ messages: RenderedMessage[]; prompt: ResolvedPrompt }>;
  };
  /** Flush and release anything this client holds. Called by the pool on eviction. */
  close(): Promise<void>;
}

/**
 * A client is a fully self-contained instance: its own platform, gateway,
 * masking rules and caches. There is no global state, so any number of
 * clients (one per tenant, per environment, per vendor) can live in one process.
 */
export function createClient(config: TasConfig): TasClient {
  const canonical = config.canonical ?? "repo";
  const defaultLabel = config.defaultLabel ?? "production";
  const ttl = config.cacheTtlMs ?? 60_000;
  const registry = config.platform.prompts;

  const local = new Map<string, PromptDefinition>();
  for (const raw of config.prompts ?? []) {
    const def = parsePrompt(raw);
    local.set(def.name, def);
  }
  const cache = new Map<string, { at: number; value: ResolvedPrompt }>();

  const fromLocal = (name: string): ResolvedPrompt | undefined => {
    const definition = local.get(name);
    return definition && { definition, hash: hashPrompt(definition), source: "local" };
  };

  /** Returns undefined when the platform has no such prompt; throws when the platform is unreachable. */
  const fromRemote = async (name: string, options: GetPromptOptions): Promise<ResolvedPrompt | undefined> => {
    if (!registry) return undefined;
    const ref = options.version
      ? { name, version: options.version }
      : { name, label: options.label ?? defaultLabel };
    const key = JSON.stringify(ref);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    try {
      const remote = await registry.get(ref);
      if (!remote) return undefined;
      const value: ResolvedPrompt = {
        definition: remote.definition,
        hash: hashPrompt(remote.definition),
        source: "remote",
        remote: { platform: config.platform.id, version: remote.version, labels: remote.labels },
      };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      if (hit) return hit.value; // stale beats down
      throw error;
    }
  };

  const get = async (name: string, options: GetPromptOptions = {}): Promise<ResolvedPrompt> => {
    // An explicit version or label is a question only the platform can answer.
    const pinned = options.version !== undefined || options.label !== undefined;
    let found: ResolvedPrompt | undefined;
    if (canonical === "repo" && !pinned) {
      found = fromLocal(name) ?? (await fromRemote(name, options));
    } else {
      try {
        found = await fromRemote(name, options);
      } catch (error) {
        // Platform down: an unpinned request may fall back to the bundled snapshot.
        if (pinned || !fromLocal(name)) throw error;
      }
      if (!found && !pinned) found = fromLocal(name);
    }
    if (!found) throw new PromptNotFoundError(`prompt "${name}" not found (canonical: ${canonical})`);
    if (found.definition.archived && !options.allowArchived) {
      throw new PromptArchivedError(`prompt "${name}" is archived. Remove \`archived: true\` to restore it, or pass { allowArchived: true }.`);
    }
    return found;
  };

  return {
    config,
    mask: createMasker(config.masking),
    prompts: {
      get,
      async render(name, input, options) {
        const prompt = await get(name, options);
        return { messages: renderPrompt(prompt.definition, input), prompt };
      },
    },
    async close() {
      cache.clear();
    },
  };
}

export interface ClientPoolOptions {
  /** Look up one tenant's config: from your database, a secrets manager, a static map... */
  resolve: (key: string) => TasConfig | Promise<TasConfig>;
  /** Most clients kept alive at once; least recently used is closed first. Default 100. */
  max?: number;
}

export interface ClientPool {
  get(key: string): Promise<TasClient>;
  /** Drop one tenant's client, e.g. after its credentials or platform changed. */
  evict(key: string): Promise<void>;
  close(): Promise<void>;
}

/** Lazily creates and reuses one client per key. Concurrent calls for the same key share one resolve. */
export function createClientPool(options: ClientPoolOptions): ClientPool {
  const max = options.max ?? 100;
  const clients = new Map<string, Promise<TasClient>>();

  const closeQuietly = async (pending: Promise<TasClient>) => {
    try {
      await (await pending).close();
    } catch {
      // a client that never resolved has nothing to close
    }
  };

  return {
    get(key) {
      let pending = clients.get(key);
      if (pending) {
        clients.delete(key); // re-insert to mark as most recently used
      } else {
        pending = Promise.resolve()
          .then(() => options.resolve(key))
          .then(createClient);
        pending.catch(() => {
          if (clients.get(key) === pending) clients.delete(key); // do not cache failures
        });
      }
      clients.set(key, pending);
      while (clients.size > max) {
        const [oldestKey, oldest] = clients.entries().next().value!;
        clients.delete(oldestKey);
        void closeQuietly(oldest);
      }
      return pending;
    },
    async evict(key) {
      const pending = clients.get(key);
      clients.delete(key);
      if (pending) await closeQuietly(pending);
    },
    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(all.map(closeQuietly));
    },
  };
}

const scope = new AsyncLocalStorage<TasClient>();

/** Bind a client to everything `fn` awaits, so deep code need not thread it through. */
export function withClient<T>(client: TasClient, fn: () => T): T {
  return scope.run(client, fn);
}

/** The client bound by the nearest `withClient`. Throws outside one: there is deliberately no global default. */
export function currentClient(): TasClient {
  const client = scope.getStore();
  if (!client) throw new Error("no tas client in scope: wrap the request in withClient(client, fn)");
  return client;
}
