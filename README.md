# Trace and Scale

> **In progress development.** Not published to npm yet; APIs may still change.

One TypeScript SDK for prompts, model calls, tracing and evals, with **Braintrust**, **Langfuse** and
**LangSmith** as interchangeable backends. Application code stays the same when the vendor changes.

```ts
import { createClient, braintrust, loadPrompts } from "@traceandscale/sdk";

const tas = createClient({
  platform: braintrust({ apiKey: process.env.BRAINTRUST_API_KEY!, projectName: "support" }), // or langfuse(...), langsmith(...)
  gateway: { baseURL: process.env.GATEWAY_URL! },                                           // any OpenAI-compatible endpoint
  prompts: await loadPrompts("./prompts"),
});

const { output } = await tas.run("support/triage", { variables: { ticket } });
```

## What it does

| | |
|---|---|
| **Prompts as files** | `*.prompt.yaml` in your repo, synced with `tas prompts push` / `pull`. You choose whether the repo or the platform is the source of truth. |
| **One way to call models** | `run`, `stream` and `chat` use the model, settings, tools and output schema stored with the prompt. Structured output is validated; tool calls are looped. |
| **Tracing with masking** | Every run, model call and tool is traced. Masking runs in your process before anything is exported. Export never blocks your code by default. |
| **Evals** | `evaluate` runs your task and scorers locally and stores the run as an experiment. `tas eval` gates CI on thresholds. |
| **Datasets** | JSONL files, pushed to and pulled from the platform. |
| **Studio** | `tas studio` opens a local editor for the prompt files, with per-platform portability notes. |

Two runtime dependencies (`typebox`, `yaml`). Vendor APIs are called with `fetch`.

## Getting started

```ts
// tas.config.ts
import { defineConfig, langfuse, pii } from "@traceandscale/sdk";

export default defineConfig({
  platform: langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY!, secretKey: process.env.LANGFUSE_SECRET_KEY! }),
  canonical: "repo",                       // which side wins on conflict: "repo" or "platform"
  gateway: { baseURL: process.env.GATEWAY_URL!, models: { "gpt-5": "openai/gpt-5" } },
  masking: { keys: ["authorization", /token/i], patterns: [pii.email] },
});
```

```yaml
# prompts/support/triage.prompt.yaml
model: { id: gpt-5, params: { temperature: 0 } }
messages:
  - role: system
    content: You triage tickets for {{company}}.
  - role: user
    content: "{{ticket.body}}"
output:
  schema:
    type: object
    properties: { queue: { type: string, enum: [billing, technical] } }
    required: [queue]
```

```bash
tas prompts status          # compare files with the platform
tas prompts push --label production
tas prompts pull            # bring edits made in the vendor UI back as file diffs
tas prompts check           # what would each platform not store natively?
tas prompts types           # generate prompts.ts for createClient<Prompts>()
tas datasets pull           # platform -> datasets/*.dataset.jsonl
tas eval evals/*.eval.ts    # exits 1 when a threshold is missed
tas studio                  # local editor at http://127.0.0.1:4983
```

More examples (streaming, tools, attachments, tracing, evals, multi-tenant clients) are in the doc
comments of [`src/client.ts`](src/client.ts) and in the tests, which are written to be read.

## Status

Every adapter passes one conformance suite against the real service. What is and is not built, and
every caveat, is in [docs/decisions.md](docs/decisions.md): it is the honest reference for behaviour.

## Working on this repository

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands, conventions and how the code is organised,
and [docs/architecture.md](docs/architecture.md) for a map of the modules.
