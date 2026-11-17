# Platform mapping

Where each part of the canonical prompt (`src/prompt/model.ts`) lives on each platform.
This is the brief for adapter authors. Checked against vendor docs on 2026-11-17;
items marked **(verify)** were not confirmed in docs and must be proven by the
conformance suite against a live account before the adapter ships.

"Envelope" means the reserved `__tas` object (`src/adapter.ts`), stored wherever the
platform allows free-form JSON.

## Prompts

| Canonical | Langfuse | LangSmith | Braintrust |
|---|---|---|---|
| Identity | `name` | repo handle in workspace (`-/name`) | `project_id` + `slug` |
| `name` with `/` | native (renders as folders) | emulated: flattened handle, real name in envelope **(verify allowed characters)** | flattened slug (`/` → `--`), real name in `name`. Verified live: slugs do accept `/`, so this could become native |
| `type: chat` | `type: "chat"`, `prompt[]` | `ChatPromptTemplate` manifest | `prompt_data.prompt.type: "chat"` |
| `type: text` | `type: "text"` (fixed at creation) | `PromptTemplate` manifest **(verify)** | `prompt.type: "completion"` |
| Placeholder message | `{type:"placeholder", name}` | `MessagesPlaceholder` **(verify)** | emulated via envelope |
| Variables | `{{var}}` native | must set `template_format: "mustache"` on every message (default is f-string) | `template_format: "mustache"` |
| `model.id` | `config.model` | `RunnableSequence.last.bound.kwargs.model`, returned only with `include_model=true` | `prompt_data.options.model` |
| `model.params` | `config.*` (OpenAI names) | `last.bound.kwargs.*` | `options.params.*`; verified live: keys the model does not support are dropped on read (e.g. `temperature` on `gpt-5`), so the intended set is also kept in the envelope |
| `tools` | `config.tools` | bound kwargs **(verify shape)**, else envelope | JSON **string** in `prompt_data.prompt.tools` |
| `output` | `config.response_format` | `StructuredPrompt.schema_` **(verify)**, else envelope | `options.params.response_format` |
| `description` | envelope (only `commitMessage` exists) | repo `description` | `description` |
| `tags` | `tags` (shared across versions) | repo `tags` (not commit tags) | `tags` |
| `metadata` | envelope | envelope | `metadata` |
| Envelope home | `config.__tas` | inside the commit `manifest` | `metadata.__tas` (verified live: REST create keeps `metadata`) |
| Version id | integer, immutable | commit hash; tag APIs want the commit **UUID** | `_xact_id` or short version id |
| Labels | `labels`, moved via `PATCH .../versions/{v}` | commit tags; `production`/`staging` are tied to Environments **(verify usable)** | environments, org-level, must already exist. Verified live: assign with `PUT /environment-object/prompt/{id}/{env}` (no `/v1`), read with `GET /environment-object/prompt/{id}`; prompt rows do not list their environments, and an unassigned environment returns 404 |
| New version | `POST /v2/prompts` with same name | create repo if missing, then `POST /commits` | re-`POST /v1/prompt` with same slug |
| Unchanged push | compare envelope hash first | compare envelope hash first | compare envelope hash first |
| Auth | Basic `pk:sk` | `X-API-Key` (+ `X-Tenant-Id`) | `Authorization: Bearer` |

Rendering always happens in this SDK from the canonical definition, never on the
platform. Platform-side template features (Langfuse `@@@langfusePrompt@@@` composition,
LangSmith/Braintrust mustache sections, Nunjucks) are outside the portable subset;
`findNonPortable` flags them and pull must fetch Langfuse prompts with `resolve=true`.

## Tracing (phase 3)

All three ingest OTLP/HTTP and read `gen_ai.*`. Differences the exporter presets absorb:

| | Langfuse | LangSmith | Braintrust |
|---|---|---|---|
| Endpoint | `/api/public/otel/v1/traces` | `/otel/v1/traces` | `/otel/v1/traces` |
| Required headers | Basic auth, `x-langfuse-ingestion-version: 4` | `x-api-key`, `Langsmith-Project` | Bearer, `x-bt-parent: project_name:<n>` |
| User / session | `langfuse.user.id`, `langfuse.session.id` | `langsmith.metadata.user_id`, `langsmith.metadata.thread_id` | `braintrust.metadata.*` |
| Tags | `langfuse.trace.tags` | `langsmith.span.tags` (comma-separated string) | `braintrust.tags` |
| Prompt link | `langfuse.observation.prompt.name` + `.version` (integer) | `langsmith.metadata.lc_hub_owner/repo/commit_hash` **(verify UI links)** | `braintrust.metadata.prompt` **(verify)** |

Every generation span also carries `tas.prompt.name` and `tas.prompt.hash`, which
survive a platform switch even where the native link does not.

## Evals (phase 4)

| | Langfuse | LangSmith | Braintrust |
|---|---|---|---|
| Report a run executed in our code | OTel only: `langfuse.experiment.*` attributes and baggage, one trace per item | runs API with `reference_example_id`, or one-shot `POST /datasets/upload-experiment` | `POST /v1/experiment` then `/insert`, rows linked by `origin` |
| Score range | numeric, boolean, categorical, text | free | must be in [0, 1] |

Canonical scores are therefore numbers in [0, 1]; anything else goes in score metadata.

## Gateways

All three now have one, all OpenAI-compatible on `/chat/completions`, none can
reference a stored prompt. Model id format differs (`<connection>:<model>` on
Langfuse, `<provider>/<model>` on LangSmith), so `model.id` is gateway-specific and
the client needs an optional per-gateway model alias map.

## LangSmith: verified live on 2026-11-17

These replace the **(verify)** notes in the LangSmith column above.

- Handles allow only `[a-z0-9_-]` and must start with a letter. `/` is stored as `--`; names starting with a digit or containing `--` are rejected by the adapter.
- A manifest must be a LangChain object with an `id`; arbitrary JSON is refused. `kwargs.metadata` round-trips exactly, so the envelope lives there.
- `MessagesPlaceholder` and a top-level `PromptTemplate` (text prompt) are accepted as written.
- A commit to a repo with history must name `parent_commit`; an unchanged manifest returns 409 "Nothing to commit".
- Commit tags named `production` and `staging` can be created and moved through the API. Tag endpoints need the commit UUID, which only the commit list exposes.
- LangSmith adds the manifest's class name (e.g. `ChatPromptTemplate`) to the repo's tags by itself.
- Model, tools and output schema are stored natively, in the structure the playground writes (taken from ~100 public hub prompts, then verified by pushing and reading back `model_provider` / `model_config`):
  - A prompt with a model is `RunnableSequence { first: <prompt>, last: RunnableBinding { bound: <model class>, kwargs: { tools } } }`.
  - Model class and API-key argument per provider are in `LANGSMITH_PROVIDERS` (`src/adapters/langsmith.ts`): OpenAI, Anthropic, Google, Groq, Fireworks, Mistral, DeepSeek. The key is always a `{type: "secret"}` reference, never a value.
  - Provider is inferred from the model id: a known prefix (`anthropic/…`), else the model family (`gpt-`, `claude`, `gemini`, …), else OpenAI-compatible. `resolveModel` overrides it.
  - `temperature`, `max_tokens`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `reasoning_effort` are real model arguments. Other params stay in the envelope.
  - Output schema makes the prompt a `StructuredPrompt` with `schema_`; the output name and strict flag live inside the schema as `title` and `strict`. Chat prompts only.
  - Tools need a model to bind to; without one they stay in the envelope.
- Not checked: how the playground UI renders these prompts (only the API's own reading of them was verified).
