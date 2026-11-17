# Architecture

A map of the code, for people and agents arriving cold. Each file also starts with a comment saying
what it is responsible for; this page is how the files fit together.

## The idea

Application code talks to one **client**. The client talks to a **platform adapter** for anything
stored on a vendor (prompts, traces, datasets, experiments) and to a **gateway** for model calls.
Adapters translate one vendor-neutral model to and from what each vendor stores. Where a vendor
cannot hold something natively, the adapter keeps it in that vendor's free-form metadata, in a
reserved object called the **envelope** (`__tas`), so what you read back is what you wrote.

```
            your code
                |
           createClient ---------------- config (platform, gateway, masking, canonical side)
           /    |     \
      prompts  run    trace / evaluate
         |      |          |
    PromptRegistry   gateway.ts        TraceExporter   ExperimentReporter   DatasetStore
         \______________ PlatformAdapter (braintrust | langfuse | langsmith | memory) ______/
```

## Modules

| Path | Responsibility |
|---|---|
| `src/index.ts` | The public API: everything exported from the package. |
| `src/client.ts` | `createClient`, the client pool for multi-tenant use, request-scoped clients. Wires the pieces below together; holds no logic of its own beyond prompt resolution and caching. |
| `src/config.ts` | The configuration types. |
| `src/adapter.ts` | The contracts every platform adapter implements (`PlatformAdapter`, `PromptRegistry`, capabilities) and the envelope helpers. |
| `src/adapters/<platform>/` | One folder per platform, one file per capability: `prompts.ts`, `tracing.ts`, `datasets.ts`, `experiments.ts`, assembled in `index.ts`. |
| `src/adapters/shared.ts` | What adapters share: the HTTP client and OpenAI-shape conversions. |
| `src/adapters/memory.ts` | An in-process platform: the reference adapter for tests and local use. |
| `src/prompt/model.ts` | The canonical prompt: its TypeBox schema, types, validation and content hash. |
| `src/prompt/template.ts` | The portable template subset: variables, placeholders, rendering, non-portable detection. |
| `src/prompt/parts.ts` | Attachments: conversion to and from the OpenAI part format, data-URI helpers. |
| `src/prompt/file.ts` | Prompt files: `*.prompt.yaml` reading and writing, the editor schema file. |
| `src/prompt/types.ts` | Typed prompts: the generator behind `tas prompts types` and the types the client uses. |
| `src/sync.ts` | The sync engine: status, push, pull, remove, and the lockfile. |
| `src/portability.ts` | What each platform would not store natively, from a prompt alone. |
| `src/http.ts` | `fetchWithRetry`: the one retry policy. |
| `src/gateway.ts` | One chat-completions request, whole or streamed. Wire level only. |
| `src/run.ts` | Invocation: the tool loop, structured output, streaming, chat, and the spans around them. |
| `src/schema.ts` | Schemas users pass in: JSON Schema or Standard Schema, validation and conversion. |
| `src/trace.ts` | The tracer: spans, masking and snapshotting at span end, batching, OTLP encoding, export modes. |
| `src/masking.ts` | The masker. |
| `src/dataset.ts` | Dataset files and the pull/push between them and a platform. |
| `src/eval.ts` | Scorers and the evaluation runner. |
| `src/cli.ts`, `src/bin.ts` | The command line as a function (`runCli`) and its one-line executable. |
| `src/studio/` | The studio: `api.ts` (everything it can do, as one function), `server.ts` (HTTP and its safeguards), `page.ts` (the page). |

## Invariants worth knowing before changing things

- **The conformance suite is the adapter contract.** `test/conformance.ts` runs against every
  adapter offline (fake servers in `test/fakes.ts`) and against the real services with
  `pnpm test:live`. An adapter is correct when it passes; a new platform starts by making it pass.
- **Push, then read back, gives the identical definition.** Anything a platform normalises or drops
  must be restored from the envelope. Idempotent push depends on this: an unchanged prompt must not
  create a version.
- **An edit made in a vendor's UI wins** over what the envelope remembers, wherever the two can
  disagree. Emulated message content carries a fingerprint of the native side for exactly this.
- **Rendering happens here, never on the platform**, and only for the portable template subset.
- **Masking and snapshotting happen once, at span end, before any exporter.**
- **No global state.** Everything hangs off a client, so tenants cannot leak into each other.
- **Runtime dependencies are `typebox` and `yaml`.** Adding one is a decision, not a convenience.

## Where decisions live

`docs/decisions.md` records every design decision and caveat, and each is pinned by a test
(`test/decisions.test.ts` holds the ones with no other home, and says where the rest are).
`docs/platform-mapping.md` has the field-level detail per vendor, with what was verified live.
