/**
 * A stand-in for the Braintrust REST API, shaped from its published docs
 * (see docs/platform-mapping.md). It proves the adapter's codec and call
 * sequence are self-consistent; it cannot prove the real API agrees.
 */
export function fakeBraintrust(options: { environments?: string[]; keepMetadata?: boolean } = {}) {
  const environments = options.environments ?? ["production", "staging"];
  type Row = Record<string, unknown> & { id: string; _xact_id: string; slug: string };
  const versions = new Map<string, Row[]>();
  const assigned = new Map<string, Map<string, string>>(); // slug -> env -> xact
  let xact = 1000;
  const calls: string[] = [];

  const withEnvs = (row: Row) => row; // like the real API, rows do not say which environments point at them
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if ((init!.headers as Record<string, string>).authorization !== "Bearer test-key") return json({ error: "unauthorized" }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === "GET" && url.pathname === "/v1/project") {
      return json({ objects: url.searchParams.get("project_name") === "demo" ? [{ id: "proj-1" }] : [] });
    }
    if (method === "GET" && url.pathname === "/v1/prompt") {
      const slug = url.searchParams.get("slug");
      if (!slug) {
        const all = [...versions.values()].map((v) => withEnvs(v.at(-1)!));
        const after = url.searchParams.get("starting_after");
        const start = after ? all.findIndex((r) => r.id === after) + 1 : 0;
        return json({ objects: all.slice(start, start + Number(url.searchParams.get("limit") ?? 100)) });
      }
      const rows = versions.get(slug) ?? [];
      const version = url.searchParams.get("version");
      const env = url.searchParams.get("environment");
      const wanted = env ? assigned.get(slug)?.get(env) : version;
      if (env && rows.length && !wanted) return json({ Code: "NotFoundError", Message: `No association found in environment ${env}` }, 404);
      const row = env || version ? rows.find((r) => r._xact_id === wanted) : rows.at(-1);
      return json({ objects: row ? [withEnvs(row)] : [] });
    }
    if (method === "POST" && url.pathname === "/v1/prompt") {
      const envs = (body.environment_slugs as string[] | undefined) ?? [];
      const unknown = envs.find((e) => !environments.includes(e));
      if (unknown) return json({ error: `environment ${unknown} does not exist` }, 400);
      const slug = body.slug as string;
      const rows = versions.get(slug) ?? [];
      versions.set(slug, rows);
      const { project_id: _p, environment_slugs: _e, ...rest } = body;
      // The real API drops parameters the model does not support (observed: temperature on gpt-5).
      const pd = structuredClone(rest.prompt_data) as { options?: { model?: string; params?: Record<string, unknown> } };
      if (pd.options?.model === "gpt-5") delete pd.options.params?.temperature;
      const stored = { ...rest, prompt_data: pd };
      const row: Row = {
        ...stored,
        metadata: options.keepMetadata === false ? null : rest.metadata,
        id: rows[0]?.id ?? `prompt-${++xact}`,
        _xact_id: String(++xact),
        slug,
      };
      rows.push(row);
      for (const e of envs) assigned.set(slug, (assigned.get(slug) ?? new Map()).set(e, row._xact_id));
      return json(withEnvs({ ...row, prompt_data: rest.prompt_data })); // the create response echoes the request
    }
    const listAssigned = /^\/environment-object\/prompt\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && listAssigned) {
      const slug = [...versions.values()].find((v) => v[0]!.id === listAssigned[1])?.[0]?.slug ?? "";
      return json({
        objects: [...(assigned.get(slug) ?? [])].map(([environment_slug, object_version]) => ({ environment_slug, object_version })),
      });
    }
    const del = /^\/v1\/prompt\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && del) {
      for (const [slug, rows] of versions) if (rows[0]!.id === del[1]) versions.delete(slug);
      return json({});
    }
    const assign = /^\/environment-object\/prompt\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (method === "PUT" && assign) {
      const rows = [...versions.values()].find((v) => v[0]!.id === assign[1]);
      if (!rows || !environments.includes(assign[2]!)) return json({ error: "not found" }, 404);
      const slug = rows[0]!.slug;
      assigned.set(slug, (assigned.get(slug) ?? new Map()).set(assign[2]!, body.object_version as string));
      return json({});
    }
    return json({ error: "no such route" }, 404);
  }) as typeof fetch;

  return { fetch: fetchImpl, calls, versions };
}

/**
 * A stand-in for the Langfuse public API, shaped from its published docs. As with the Braintrust
 * fake, it proves self-consistency only; test/langfuse.live.test.ts checks the real thing.
 */
export function fakeLangfuse() {
  type Row = { name: string; version: number; type: string; prompt: unknown; config: unknown; labels: string[]; tags: string[] };
  const store = new Map<string, Row[]>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const expected = `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`;

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if ((init!.headers as Record<string, string>).authorization !== expected) return json({ message: "unauthorized" }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const path = url.pathname.replace("/api/public/v2/prompts", "");
    if (path === url.pathname) return json({ message: "no such route" }, 404);

    if (method === "GET" && path === "") {
      const all = [...store.values()].map((v) => ({
        name: v[0]!.name,
        labels: [...new Set(v.flatMap((r) => r.labels))],
        tags: v[0]!.tags,
      }));
      const limit = Number(url.searchParams.get("limit")),
        page = Number(url.searchParams.get("page"));
      return json({ data: all.slice((page - 1) * limit, page * limit), meta: { totalPages: Math.max(1, Math.ceil(all.length / limit)) } });
    }
    if (method === "POST" && path === "") {
      const rows = store.get(body.name) ?? [];
      if (rows[0] && rows[0].type !== body.type) return json({ message: "type cannot change" }, 400);
      store.set(body.name, rows);
      const labels = [...new Set([...(body.labels ?? []), "latest"])];
      for (const r of rows) r.labels = r.labels.filter((l) => !labels.includes(l));
      const prompt = Array.isArray(body.prompt) ? body.prompt.map((m: any) => (m.type ? m : { ...m, type: "chatmessage" })) : body.prompt;
      const row: Row = {
        name: body.name,
        version: rows.length + 1,
        type: body.type,
        prompt,
        config: body.config ?? {},
        labels,
        tags: body.tags ?? [],
      };
      rows.push(row);
      for (const r of rows) r.tags = row.tags; // tags belong to the prompt, not the version
      return json(row);
    }
    const versionPath = /^\/(.+)\/versions\/(\d+)$/.exec(path);
    if (method === "PATCH" && versionPath) {
      const rows = store.get(decodeURIComponent(versionPath[1]!)) ?? [];
      const row = rows.find((r) => r.version === Number(versionPath[2]));
      if (!row) return json({ message: "not found" }, 404);
      for (const r of rows) r.labels = r.labels.filter((l) => !body.newLabels.includes(l));
      row.labels = [...body.newLabels, ...(row === rows.at(-1) ? ["latest"] : [])]; // replaces, the stricter reading of the docs
      return json(row);
    }
    if (method === "DELETE") {
      const existed = store.delete(decodeURIComponent(path.slice(1)));
      return existed ? new Response(null, { status: 204 }) : json({ message: "not found" }, 404);
    }
    if (method === "GET") {
      const rows = store.get(decodeURIComponent(path.slice(1))) ?? [];
      const version = url.searchParams.get("version");
      const label = url.searchParams.get("label") ?? "production";
      const row = version ? rows.find((r) => r.version === Number(version)) : rows.find((r) => r.labels.includes(label));
      return row ? json(row) : json({ message: "not found" }, 404);
    }
    return json({ message: "no such route" }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, store };
}

/**
 * A stand-in for the LangSmith API. Unlike the other two fakes, its rules were taken from probing the
 * real service (parent commit required, "nothing to commit", handle charset, tags by commit UUID, auto tags).
 */
export function fakeLangSmith() {
  type Commit = { id: string; commit_hash: string; manifest: any };
  type Repo = {
    repo_handle: string;
    repo_type: string;
    description: string;
    tags: string[];
    commits: Commit[];
    commitTags: Map<string, string>;
  };
  const repos = new Map<string, Repo>();
  let counter = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if ((init!.headers as Record<string, string>)["x-api-key"] !== "ls-test") return json({ detail: "unauthorized" }, 401);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    const path = url.pathname.replace("/api/v1", "");
    let m: RegExpExecArray | null;

    if (path === "/repos" && method === "POST") {
      if (!/^[a-z][a-z0-9_-]*$/.test(body.repo_handle))
        return json({ detail: "handle must be lowercase alphanumeric, hyphen, or underscore" }, 400);
      if (repos.has(body.repo_handle)) return json({ detail: "exists" }, 409);
      repos.set(body.repo_handle, {
        repo_handle: body.repo_handle,
        repo_type: "prompt",
        description: body.description ?? "",
        tags: body.tags ?? [],
        commits: [],
        commitTags: new Map(),
      });
      return json({ repo: {} });
    }
    if (path === "/repos" && method === "GET") {
      const all = [...repos.values()].map((r) => ({
        repo_handle: r.repo_handle,
        repo_type: r.repo_type,
        commit_tags: [...r.commitTags.keys()],
      }));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json({ repos: all.slice(offset, offset + Number(url.searchParams.get("limit"))), total: all.length });
    }
    if ((m = /^\/repos\/-\/([^/]+)$/.exec(path))) {
      const repo = repos.get(m[1]!);
      if (!repo) return json({ detail: "not found" }, 404);
      if (method === "DELETE") {
        repos.delete(m[1]!);
        return json({});
      }
      if (method === "PATCH") Object.assign(repo, { description: body.description, tags: body.tags });
      return json({ repo: { ...repo, tags: [...repo.tags, repo.commits.at(-1)?.manifest.id.at(-1)].filter(Boolean) } });
    }
    if ((m = /^\/repos\/-\/([^/]+)\/tags(?:\/([^/]+))?$/.exec(path))) {
      const repo = repos.get(m[1]!);
      if (!repo) return json({ detail: "not found" }, 404);
      if (method === "GET") {
        return json(
          [...repo.commitTags].map(([tag_name, id]) => ({ tag_name, commit_hash: repo.commits.find((c) => c.id === id)!.commit_hash })),
        );
      }
      if (!repo.commits.some((c) => c.id === body.commit_id)) return json({ detail: "commit_id must be a commit UUID" }, 422);
      const tag = method === "POST" ? body.tag_name : decodeURIComponent(m[2]!);
      if (method === "POST" && repo.commitTags.has(tag)) return json({ detail: "tag exists" }, 409);
      if (method === "PATCH" && !repo.commitTags.has(tag)) return json({ detail: "not found" }, 404);
      repo.commitTags.set(tag, body.commit_id);
      return json({});
    }
    if ((m = /^\/commits\/-\/([^/]+)(?:\/([^/]+))?$/.exec(path))) {
      const repo = repos.get(m[1]!);
      if (method === "POST") {
        if (!repo) return json({ detail: "not found" }, 404);
        if (!body.manifest?.id) return json({ detail: "Manifest must have an id field" }, 400);
        const latest = repo.commits.at(-1);
        if (latest && !repo.commits.some((c) => c.commit_hash === body.parent_commit))
          return json({ detail: "Parent commit validation failed" }, 409);
        if (latest && JSON.stringify(latest.manifest) === JSON.stringify(body.manifest)) return json({ detail: "Nothing to commit" }, 409);
        const commit = { id: `uuid-${++counter}`, commit_hash: `${counter}`.padStart(64, "0"), manifest: body.manifest };
        repo.commits.push(commit);
        return json({ commit });
      }
      if (!m[2]) {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return json({ commits: (repo?.commits ?? []).slice(offset, offset + 100).map(({ id, commit_hash }) => ({ id, commit_hash })) });
      }
      const ref = decodeURIComponent(m[2]);
      const commit =
        ref === "latest" ? repo?.commits.at(-1) : repo?.commits.find((c) => c.commit_hash === ref || c.id === repo.commitTags.get(ref));
      return commit
        ? json({ commit_hash: commit.commit_hash, manifest: commit.manifest, examples: [] })
        : json({ detail: "Commit not found" }, 404);
    }
    return json({ detail: "no such route" }, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, repos };
}
