# Trace and Scale

[![CI](https://github.com/xternalAI/tas-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/xternalAI/tas-sdk/actions/workflows/ci.yml)
[![Coverage](https://github.com/xternalAI/tas-sdk/raw/badges/coverage.svg)](https://github.com/xternalAI/tas-sdk/actions/workflows/ci.yml)

One TypeScript SDK for prompts, model calls, tracing and evals, with **Braintrust**, **Langfuse** and
**LangSmith** as interchangeable backends. Your application talks to one API; which vendor stores the
prompts, traces and experiments is a line of configuration.

```ts
import { createClient, langfuse, loadPrompts } from "@traceandscale/sdk";

const tas = createClient({
  platform: langfuse({ publicKey: "pk-lf-...", secretKey: "sk-lf-..." }), // or braintrust(...), langsmith(...)
  gateway: { baseURL: "https://litellm.internal/v1", apiKey: "..." }, // any OpenAI-compatible endpoint
  prompts: await loadPrompts("./prompts"),
});

const { output } = await tas.run("support/triage", { variables: { company: "Acme", ticket: { body: "Card declined" } } });
```

- **Prompts as files.** `*.prompt.yaml` in your repository, synced with the platform in either
  direction. You choose which side is the source of truth.
- **One way to call models.** `run`, `stream` and `chat` use the model, settings, tools and output
  schema stored with the prompt, through any OpenAI-compatible gateway.
- **Tracing with masking.** Every run, model call and tool is traced. Masking happens in your
  process, before anything leaves it. Export runs in the background.
- **Evals.** Run a task over a dataset, score it, store it as an experiment, gate CI on thresholds.
- **A way out.** `tas prompts migrate` copies prompts, labels and version history from one
  platform to another.
- **Two runtime dependencies** (`typebox`, `yaml`). Vendor APIs are called with `fetch`; no vendor
  SDK is installed.

> **Status: 0.x.** Every adapter passes one conformance suite against the real service, but the API
> may still change between minor versions. Every caveat is written down in
> [docs/decisions.md](docs/decisions.md); the main ones are [listed below](#caveats).

## Contents

- [Install](#install)
- [Configure](#configure)
- [Prompts](#prompts)
- [Calling models](#calling-models)
- [Tracing and masking](#tracing-and-masking)
- [Evals and datasets](#evals-and-datasets)
- [Switching or leaving a platform](#switching-or-leaving-a-platform)
- [Several tenants in one process](#several-tenants-in-one-process)
- [CLI reference](#cli-reference)
- [What each platform stores natively](#what-each-platform-stores-natively)
- [Caveats](#caveats)

## Install

```bash
npm install @traceandscale/sdk
```

Node 22.18 or newer. The package is ESM only and ships its own types.

## Configure

One file configures both the CLI and, if you like, your application:

```ts
// tas.config.ts
import { defineConfig, langfuse, pii } from "@traceandscale/sdk";

export default defineConfig({
  platform: langfuse({ publicKey: process.env.LANGFUSE_PUBLIC_KEY!, secretKey: process.env.LANGFUSE_SECRET_KEY! }),
  canonical: "repo", // which side wins when files and platform disagree: "repo" or "platform"
  gateway: {
    baseURL: process.env.GATEWAY_URL!,
    apiKey: process.env.GATEWAY_KEY!,
    models: { "gpt-5": "openai/gpt-5" }, // prompt model id -> what this gateway calls it
  },
  masking: { keys: ["authorization", /token/i], patterns: [pii.email] },
});
```

The three platforms:

```ts
braintrust({ apiKey, projectName: "support" }); // the project must exist; labels are Braintrust environments
langfuse({ publicKey, secretKey, baseURL: "https://us.cloud.langfuse.com" }); // baseURL optional; self-hosted works
langsmith({ apiKey, project: "support" }); // project receives traces
```

Credentials are always passed in. The SDK never reads environment variables itself, so one process
can hold any number of keys.

`canonical` decides who wins:

| | `canonical: "repo"` (default) | `canonical: "platform"` |
|---|---|---|
| Source of truth | the prompt files | the platform |
| At runtime | bundled prompts are used; no network call to fetch them | prompts are fetched (cached 60 s; a stale copy is served if the platform is down), with bundled files as fallback |
| `tas prompts push` | always writes | refuses if someone changed the prompt on the platform since the last sync |
| `tas prompts pull` | refuses if the file changed since the last sync | always writes |

`--force` lets the other side win once.

## Prompts

A prompt is a YAML file. Its name is its path: `prompts/support/triage.prompt.yaml` is `support/triage`.

```yaml
# yaml-language-server: $schema=../prompt.schema.json
description: Routes a ticket to a queue
model:
  id: gpt-5
  params: { temperature: 0 }
messages:
  - role: system
    content: You triage tickets for {{company}}.
  - placeholder: history # a slot for a list of messages
  - role: user
    content: "{{ticket.body}}"
tools:
  - name: lookup_order
    description: Find an order by id
    parameters: { type: object, properties: { id: { type: string } }, required: [id] }
output:
  schema:
    type: object
    properties: { queue: { type: string, enum: [billing, technical] } }
    required: [queue]
```

`tas prompts schema` writes `prompt.schema.json` so editors validate and autocomplete these files.

**Variables** are `{{name}}` and `{{nested.path}}`. That subset means the same thing on every
platform. Anything else (`{{#if}}`, filters, f-strings) is flagged as non-portable: rendering it
throws, and pushing it needs `--force`.

**Attachments** are message parts. A `url` can be an `https://` address, a `data:` URI or a variable:

```yaml
messages:
  - role: user
    content:
      - { type: text, text: "Compare the screenshot with the report." }
      - { type: image, url: "{{screenshot}}", detail: high }
      - { type: file, url: "{{report}}", name: report.pdf, mediaType: application/pdf }
      - { type: audio, url: "{{recording}}", format: wav }
      - { type: video, url: "{{clip}}" }
```

**Syncing:**

```bash
tas prompts status                  # compare files with the platform
tas prompts push --label production # create versions; point the label at them
tas prompts pull                    # bring edits made in the vendor's UI back as file diffs
tas prompts check                   # what would each platform not store natively?
```

Pushing unchanged content creates nothing. A `tas.lock.json` beside the prompts records the last
state both sides agreed on; commit it.

**Retiring a prompt:** set `archived: true` in the file and push. It stays on the platform, with
its history, and `tas.run` refuses it. `tas prompts delete <name> --yes` removes every version for
good. Sync itself never deletes anything on a platform.

**Typed prompts:** `tas prompts types` writes `prompts/prompts.ts`. Pass it to the client and prompt
names, variables and outputs are checked at compile time:

```ts
import type { Prompts } from "./prompts/prompts.ts";

const tas = createClient<Prompts>(config);
await tas.run("support/triage", { variables: { company: "Acme" } }); // compile error: ticket is missing
```

**Studio:** `tas studio` opens a local editor for the prompt files at `http://127.0.0.1:4983`, with
live validation, per-platform notes, sync, and a test run. It serves on your machine only.

## Calling models

`gateway` is any endpoint that speaks the OpenAI chat completions API: LiteLLM, OpenRouter, a
vendor's gateway, a provider directly, a local Ollama.

```ts
// One call. The prompt's model, settings, tools and output schema are used.
const result = await tas.run("support/triage", { variables, label: "staging" });
result.output; // parsed and validated against the prompt's output schema
result.text;   // the raw reply
result.usage;  // { inputTokens, outputTokens, totalTokens }

// Streaming.
const stream = tas.stream("support/reply", { variables });
for await (const delta of stream.text) process.stdout.write(delta);
const final = await stream.result; // the same value run() returns

// Tools: give a function for each tool the prompt declares and the loop is run for you.
await tas.run("support/triage", {
  variables,
  tools: { lookup_order: async ({ id }) => db.orders.find(id) },
  maxSteps: 8,
});

// A conversation.
const chat = tas.chat("support/reply", { variables, trace: { sessionId: "conv-42" } });
await chat.send("My card was declined");
await chat.send("It is a Visa");
```

**Choosing a version.** Any call can name a past version, or a label (an "environment" on some
platforms; both words work):

```ts
await tas.run("support/triage", { variables, version: "12" });          // a past version, by the platform's id
await tas.run("support/triage", { variables, environment: "staging" }); // the same as label: "staging"
```

To do that for everything in a block without touching the calls inside it, for example to serve a
preview deployment from "staging" or to replay an incident with the prompt as it was then:

```ts
await tas.withPromptOverrides(
  { environment: "staging", prompts: { "support/triage": { version: "12" } } },
  () => handleRequest(req),
);
```

The call wins over the block, and a per-prompt entry wins over the block's environment. An
overridden prompt is always read from the platform and throws if it is not there.

Override per call with `model`, `params` and `output`. `output` accepts a JSON Schema or any
[Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType, TypeBox), and the
result is typed from it:

```ts
import { z } from "zod";

const { output } = await tas.run("support/triage", { variables, output: z.object({ queue: z.string() }) });
```

A tool call with no function ends the run and is returned in `result.toolCalls` for you to handle.
A reply that fails validation throws `OutputValidationError`. Requests are retried on 429 and 5xx
(`gateway.retries`, default 2).

To use only the prompts and call the model yourself: `await tas.prompts.render(name, { variables })`
returns OpenAI-format messages.

## Tracing and masking

`run`, `stream` and `chat` are traced without any setup: one span per run, per model call and per
tool. Group them, and add your own steps, with `trace`:

```ts
const answer = await tas.trace("handle-ticket", { userId: "u-1", sessionId: "conv-42", tags: ["support"] }, async (span) => {
  const triage = await tas.run("support/triage", { variables });
  const order = await tas.trace("load-order", () => db.orders.find(ticket.orderId));
  span.update({ metadata: { triage: triage.text } });
  return tas.run("support/reply", { variables: { ...variables, order } });
});
```

**Masking** runs once, in your process, on inputs, outputs, metadata and error messages, so every
platform receives the same redacted data:

```ts
masking: {
  keys: ["password", "authorization", /token/i], // values under these keys are replaced whole
  patterns: [pii.email, pii.creditCard],          // replaced inside every string
  custom: (value, path) => value,                 // the last word on every leaf
}
```

User id, session id, tags and span names are not masked; keep sensitive data out of them. To record
nothing for a span and everything under it, pass `capture: { input: false, output: false }`.
Inline attachments are recorded as a short note (`[image/png attachment, 12 kB]`), not their bytes.

**Tracing does not slow your application down.** Recording a span does no network work.

| `traceExport.mode` | When spans are sent | Your code waits? |
|---|---|---|
| `"buffered"` (default) | in batches: every 2 s or 50 spans | never |
| `"immediate"` | when each trace finishes, in the background | never |
| `"blocking"` | when each trace finishes; the outermost call returns after the platform answers | yes, by design: for runtimes that freeze the process when a handler returns |

In a script or a serverless handler, call `await tas.flush()` before exiting. A platform that is
down never throws into your code: failures go to `onTraceError`.

**Where traces go:**

```ts
import * as api from "@opentelemetry/api";
import { otlp } from "@traceandscale/sdk";

createClient({
  platform: langfuse({ ... }),
  tracing: [langfuse({ ... }), braintrust({ ... })], // the same spans to two platforms, e.g. while switching
  // tracing: [otlp({ url: "http://localhost:4318/v1/traces" })], // any OpenTelemetry backend
  // tracing: false,
  openTelemetry: api, // join your app's existing OpenTelemetry traces; no dependency is added
});
```

With `openTelemetry`, spans from this SDK nest under your active span and are exported by your own
pipeline (masked first). If that pipeline already delivers to the platform, set `tracing: false`.

## Evals and datasets

```ts
// evals/triage.eval.ts
import { defineEval, exactMatch, judge, loadDataset, type TasClient } from "@traceandscale/sdk";

export default async (tas: TasClient) =>
  defineEval({
    name: "triage",
    data: await loadDataset("datasets/tickets.dataset.jsonl"),
    task: async (input) => (await tas.run("support/triage", { variables: { ticket: input } })).output,
    scorers: {
      correct: exactMatch,
      polite: judge(tas, "judges/politeness"), // a prompt that returns { score: 0..1, reason }
      short: ({ output }) => JSON.stringify(output).length < 200,
    },
    thresholds: { correct: 0.9 },
  });
```

```bash
tas eval evals/*.eval.ts   # exits 1 when a threshold is missed
```

Or in code: `const result = await tas.evaluate("triage", { data, task, scorers })`. The task and
the scorers run on your machine, so results are the same whichever vendor stores them. Scores are
numbers from 0 to 1. The run is stored as an experiment on the platform, with a trace per item.

Datasets are JSONL files, one item per line:

```jsonl
{"id":"t1","input":{"body":"Card declined"},"expected":{"queue":"billing"}}
{"id":"t2","input":{"body":"App crashes on login"},"expected":{"queue":"technical"},"metadata":{"source":"zendesk"}}
```

```bash
tas datasets push          # files -> platform, upserting items by id
tas datasets pull          # platform -> files
```

## Switching or leaving a platform

With `canonical: "repo"`, changing vendor is changing `platform` in the config and running
`tas prompts push`. Your application code does not change.

To carry over labels and version history, or when prompts live on the platform, define both
platforms as profiles and migrate:

```ts
// tas.config.ts
export default defineConfig({
  default: "old",
  profiles: {
    old: { platform: langfuse({ ... }) },
    new: { platform: braintrust({ ... }) },
  },
});
```

```bash
tas prompts migrate --from old --to new            # the newest version and every labelled one
tas prompts migrate --from old --to new --history  # every version, oldest first
tas datasets migrate --from old --to new
```

Labels point at the same content afterwards. Each version is read back and compared; running it
again creates nothing. Traces and past experiments are not moved. During a switch,
`tracing: [oldPlatform, newPlatform]` sends traces to both.

## Several tenants in one process

A client holds no global state: its own platform, gateway, masking rules, caches and tracer.

```ts
import { createClientPool, withClient, currentClient } from "@traceandscale/sdk";

const pool = createClientPool({
  resolve: async (tenantId) => loadTenantConfig(tenantId), // returns the same shape as tas.config.ts
  max: 100, // least recently used clients are flushed and closed
});

app.use(async (req, next) => withClient(await pool.get(req.tenantId), next));
// anywhere below, without passing the client around:
await currentClient().run("support/triage", { variables });
```

## CLI reference

```
tas prompts status|check|pull|push|delete|migrate|schema|types [names...]
tas datasets list|pull|push|migrate [names...]
tas eval <files...>
tas studio

--config <path>     config file (default: tas.config.ts)
--profile <name>    which profile of a multi-profile config to use
--label <label>     push: point this label at the pushed version (repeatable)
--force             let the non-canonical side win; push non-portable template syntax
--yes               delete: confirm
--from, --to        migrate: the profiles to copy from and to
--history           migrate: copy every version
--port <number>     studio: port (default 4983)
```

`tas --help` describes each command.

## What each platform stores natively

Everything round-trips on every platform. Where a platform has no field for something, it is kept
in a reserved `__tas` metadata object on that platform and restored when read, so your code sees no
difference. The difference is only in what the vendor's own UI and playground show.
`tas prompts check` reports this per prompt, without contacting any platform.

| | Braintrust | Langfuse | LangSmith |
|---|---|---|---|
| Messages, model, settings | native | native | native (common settings become playground controls) |
| Tools, output schema | native for chat prompts | native | native when the prompt names a model |
| Labels | environments (must exist in the org) | labels | commit tags |
| Images | native | marker in text + metadata | native |
| Files, audio | native | marker in text + metadata | metadata |
| Video | metadata | marker in text + metadata | metadata |
| Placeholders | metadata | native | native |
| Description, tags | native | tags native; description in metadata | per repository; per-version copy in metadata |
| Names with `/` | native | native | stored with `--` in place of `/` |
| Listing versions (for `migrate --history`) | not available | yes | yes |

Field-by-field detail is in [docs/platform-mapping.md](docs/platform-mapping.md).

## Caveats

The complete list, each one pinned by a test, is [docs/decisions.md](docs/decisions.md). The ones
most likely to matter:

- **LangSmith experiments rely on an endpoint LangSmith plans to remove.** Experiments are stored
  through LangSmith's v1 sessions and runs API, the way its own SDK does it. LangSmith has announced
  the v1 sessions endpoint will be removed on **2027-07-01**. Its newer one-call experiment upload
  is not a replacement yet: it only accepts datasets that it created itself, which could then not
  be pushed to or edited normally. Before that date this adapter has to move; until then it works,
  and prompts, tracing and datasets on LangSmith are not affected. LangSmith experiments also
  return no URL.
- **Version history cannot be migrated out of Braintrust.** We found no API that lists a prompt's
  versions. Labelled versions and the newest one migrate; history into Braintrust works.
- **Braintrust labels are environments**, which are org-wide and must be created in Braintrust
  first. Assigning them uses endpoints outside Braintrust's published API reference.
- **Edits made in a vendor's UI win over emulated fields.** If someone edits a prompt in the
  vendor's UI, what they saved there is what you get, and fields that platform keeps only in
  metadata come back as the UI left them.
- **Versions get the platform's ids.** A version id means something on one platform only; the
  content hash on every trace (`tas.prompt.hash`) is what identifies a prompt across platforms.
- **Scores exist on evaluation runs only**, not on live traces.
- **Not portable, and out of scope:** historical traces, evaluators configured in a vendor's UI,
  annotation queues, playground sessions.
- **Langfuse datasets cannot be deleted through its API**; remove them in its UI.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the commands and rules, [docs/architecture.md](docs/architecture.md)
the map of the code. Offline tests run in CI on every push; tests against the real services are
opt-in (`pnpm test:live`).

## License

[MIT](LICENSE)
