/**
 * Dev-only: deletes what the live conformance tests and ad-hoc probes leave behind.
 *
 *   pnpm cleanup:live            delete test prompts (names starting "tas-live-" or "probe-")
 *   pnpm cleanup:live --dry-run  list them without deleting
 *
 * Each platform is cleaned only if its credentials are in the environment or .env.
 * Braintrust: only the project named by TAS_LIVE_PROJECT; covers prompts, scorers and tools.
 * Langfuse: the project the keys belong to; deleting a prompt removes all its versions.
 * LangSmith: private prompts in the workspace the key belongs to.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env file
}
const env = process.env;
const dryRun = process.argv.includes("--dry-run");
const isOurs = (name: string) => ["tas-live-", "probe-"].some((p) => name.startsWith(p));
const verb = dryRun ? "would delete" : "deleted";

async function call<T>(method: string, url: string, authorization: string): Promise<T> {
  const response = await fetch(url, { method, headers: { authorization } });
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const text = await response.text(); // Langfuse answers DELETE with an empty body
  return (text ? JSON.parse(text) : undefined) as T;
}

async function braintrust(apiKey: string, projectName: string): Promise<number> {
  const base = "https://api.braintrust.dev";
  const auth = `Bearer ${apiKey}`;
  const projects = await call<{ objects: { id: string }[] }>("GET", `${base}/v1/project?project_name=${encodeURIComponent(projectName)}`, auth);
  const projectId = projects.objects[0]?.id;
  if (!projectId) throw new Error(`braintrust project "${projectName}" not found`);
  let count = 0;
  for (const kind of ["prompt", "function"]) {
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await call<{ objects: { id: string; slug: string }[] }>(
        "GET",
        `${base}/v1/${kind}?project_id=${projectId}&limit=100${after ? `&starting_after=${after}` : ""}`,
        auth,
      );
      for (const row of page.objects) {
        if (seen.has(row.id) || !isOurs(row.slug)) continue;
        seen.add(row.id);
        if (!dryRun) await call("DELETE", `${base}/v1/${kind}/${row.id}`, auth);
        console.log(`braintrust: ${verb} ${kind} ${row.slug}`);
        count++;
      }
      after = page.objects.at(-1)?.id;
      if (page.objects.length < 100 || !after) break;
    }
  }
  return count;
}

async function langfuse(publicKey: string, secretKey: string, baseURL: string): Promise<number> {
  const base = `${baseURL.replace(/\/$/, "")}/api/public/v2/prompts`;
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  // Collect first: deleting while paging would shift the pages under us.
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const result = await call<{ data: { name: string }[]; meta: { totalPages: number } }>("GET", `${base}?page=${page}&limit=100`, auth);
    names.push(...result.data.map((p) => p.name).filter(isOurs));
    if (page >= result.meta.totalPages) break;
  }
  for (const name of names) {
    if (!dryRun) await call("DELETE", `${base}/${encodeURIComponent(name)}`, auth);
    console.log(`langfuse: ${verb} prompt ${name}`);
  }
  return names.length;
}

async function langsmith(apiKey: string, baseURL: string): Promise<number> {
  const base = `${baseURL.replace(/\/$/, "")}/api/v1/repos`;
  const send = async <T>(method: string, url: string): Promise<T> => {
    const response = await fetch(url, { method, headers: { "x-api-key": apiKey } });
    if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const handles: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await send<{ repos: { repo_handle: string }[]; total: number }>("GET", `${base}?is_public=false&limit=100&offset=${offset}`);
    handles.push(...page.repos.map((r) => r.repo_handle).filter(isOurs));
    if (!page.repos.length || offset + page.repos.length >= page.total) break;
  }
  for (const handle of handles) {
    if (!dryRun) await send("DELETE", `${base}/-/${handle}`);
    console.log(`langsmith: ${verb} prompt ${handle}`);
  }
  return handles.length;
}

let total = 0;
let ran = false;
if (env.BRAINTRUST_API_KEY && env.TAS_LIVE_PROJECT) {
  ran = true;
  total += await braintrust(env.BRAINTRUST_API_KEY, env.TAS_LIVE_PROJECT);
}
if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
  ran = true;
  total += await langfuse(env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY, env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com");
}
if (env.LANGSMITH_API_KEY) {
  ran = true;
  total += await langsmith(env.LANGSMITH_API_KEY, env.LANGSMITH_BASE_URL ?? "https://api.smith.langchain.com");
}
if (!ran) throw new Error("no live credentials found (see the *.live.test.ts files for the variables)");
console.log(`${dryRun ? "Would delete" : "Deleted"} ${total} item(s).`);
