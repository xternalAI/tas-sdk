# Decisions and caveats

A running log of design decisions and the caveats that follow from them, kept as raw
material for the user-facing documentation. Newest sections are appended; each entry
says what was decided, why, and what a user needs to know.

**Every entry here must be pinned by a unit test**, above all the things we deliberately flag,
refuse or do not handle. Tests that exist only for that reason live in
`test/decisions.test.ts`; its header says where the rest are. Changing a decision means
changing its test and its entry here together.

"Verified live" means checked against the real service on 2026-11-17. Field-level
platform detail lives in [platform-mapping.md](platform-mapping.md).

## Scope and positioning

- **Goal is no vendor lock-in.** Application code talks to one API; Braintrust, Langfuse and LangSmith are interchangeable backends. Switching vendor is a config change plus one `tas prompts push`.
- **We do not build a tracing data model or a provider layer.** Tracing will be OpenTelemetry with per-platform exporters; invocation will go through any OpenAI-compatible gateway. Both are already commodities.
- **Some platform features cannot be made portable** and are out of scope: historical traces, UI-configured online evaluators, annotation queues, playground sessions.

## Dependencies

- **Runtime dependencies are `typebox` and `yaml` only.** Neither has dependencies of its own. Fewer dependencies is treated as a security feature.
- **Adapters call vendor REST APIs with `fetch`.** No vendor SDK is installed. *Caveat:* we track vendor API changes ourselves.
- **TypeBox validates our own prompt shape.** It was chosen over zod (more installs, more advisories) and over a hand-written validator (no JSON Schema export). *Caveats:* TypeBox does not implement Standard Schema; it stops reporting after a handful of errors, so a file with many mistakes shows them in rounds.
- **User-supplied schemas (planned)** will be accepted as plain JSON Schema or any Standard Schema validator, with the Standard Schema types copied in rather than depended on.
- **Credentials are always passed explicitly** to an adapter, never read from the environment, so one process can hold several tenants' keys.

## Canonical prompt model

- **One prompt shape for every platform**: chat (messages) or text, plus optional model, tools, output schema, description, tags, metadata. Exported as JSON Schema (`promptSchema`) to serve as the spec for SDKs in other languages.
- **Names are lowercase path segments** (`support/triage`). *Caveat:* LangSmith adds further limits, see below.
- **Unknown keys are errors**, so a typo in a prompt file fails instead of being ignored.
- **Identity across platforms is a content hash** of the canonical definition. Platform version ids are opaque strings and differ per vendor.
- **`model.id` is whatever your gateway expects.** It is not normalised. *Caveat:* gateways name models differently, so the same prompt may need a different id per gateway.
- **`model.params` uses OpenAI parameter names.** `model.id` is required whenever params are set.

- **Prompt files have a JSON Schema for editors.** `tas prompts schema` writes `prompt.schema.json` into the prompts directory; files written by the SDK start with a `# yaml-language-server: $schema=...` comment pointing at it, so they validate and autocomplete with no editor setup. Every field has a description, which is the hover text. *Caveat:* files written by hand need that first line added, or an editor mapping such as VS Code's `yaml.schemas`. The schema is draft-07, generated from the same TypeBox definitions the SDK validates with, so the two cannot drift.

- **Typed prompts are opt-in.** `tas prompts types` writes `prompts.ts` into the prompts directory: an interface listing each prompt's variables (nested paths become nested objects), placeholders and output type (from its JSON Schema). `createClient<Prompts>()` then makes a wrong prompt name, a missing variable or a wrong placeholder a compile error, and types `result.output`. Without the type parameter nothing changes. *Caveats:* it is a generated file that must be re-run when prompts change; variable values are typed as "anything but undefined", since a variable has no declared type; output types cover common JSON Schema (objects, arrays, enums, unions) and fall back to `unknown`. Types describe the files in the repo, so with platform-canonical prompts they can lag behind what the platform serves.

## Templates and variables

- **Portable subset only:** `{{name}}` and `{{nested.path}}`. `{{{name}}}` and `{{&name}}` are accepted as the same thing, since nothing is HTML-escaped.
- **Rendering always happens in the SDK**, never on the platform, so output is identical whichever vendor stores the prompt.
- **Not portable, by decision:** sections and loops (`{{#x}}`), partials, filters, variable names with hyphens, Nunjucks/Jinja blocks, Langfuse prompt references.
- **Non-portable syntax is never sent to a model silently.** Rendering throws; `{ strict: false }` passes it through as written. `tas prompts push` refuses such prompts without `--force`; `status` and `pull` report them.
- **Missing variable throws.** Non-string values are inserted as JSON.
- **There is no way to write a literal `{{`** in a prompt. Single braces (JSON examples) are safe.
- **LangSmith f-string prompts are converted to `{{var}}` on read.** *Caveat:* format specifiers such as `{price:.2f}` become non-portable and are flagged.

## Attachments

Pinned by the "decisions: attachments" tests. Verified live on 2026-11-17: a prompt with text, two images and a file round-tripped on all three platforms, and a local model correctly described an image sent through `run`.

- **A message's content is text, or a list of parts: `text`, `image`, `file`.** An attachment is identified by a `url`, which is an https URL, a `data:` URI, or a `{{variable}}` filled with either at call time. Text prompts (the single-string kind) cannot have parts.
- **Attachments are usually variables.** The prompt declares where the image or file goes; the call supplies it. `fileToDataUrl(path)` and `dataUrl(bytes, type)` turn local content into a value to pass.
- **On the wire, parts use the OpenAI chat format.** Images become `image_url`. Inline files become `file.file_data`; a file given by URL becomes `file.file_id` with `format`, which is the convention LiteLLM accepts. *Caveat:* whether a file is accepted, and by URL or only inline, depends on the gateway and model. Images are widely supported; files are not.
- **Audio and video parts are not supported.**
- **Traces record a note instead of attachment bytes**, such as `[image/png attachment, 12 kB]`, for any inline attachment over 256 characters. `capture: { attachments: true }` records them in full; the setting is inherited down the trace.
- **How each platform stores a prompt with attachments:**
  - *Braintrust:* natively, in its own message format. Images and files attached in the Braintrust UI are read back.
  - *LangSmith:* images natively, as image templates, so they work in its playground. It has no template for files, so a prompt with a file part keeps its real messages in the envelope and shows everything but the files natively.
  - *Langfuse:* messages can only be text (its API rejects anything else). The text is stored with a marker where each attachment goes, such as `[image: {{screenshot}}]`, and the real messages are kept in the envelope. *Caveat:* in the Langfuse playground such a prompt runs as text only.
- **An edit in the vendor UI still wins.** Where real messages are kept in the envelope, a fingerprint of what was written natively is kept with them. If the native side has changed since, the envelope's copy is ignored, which means attachments the platform never held are dropped from that version.

## Canonical side and sync

- **The user picks which side is the truth, per config:** `canonical: "repo"` (default) or `"platform"`.
- **One rule for conflicts:** the canonical side always wins; the other side never overwrites it without `--force`.
- **Runtime resolution:** repo-canonical serves bundled files; platform-canonical fetches from the platform and falls back to bundled files if it is unreachable. An explicit label or version always asks the platform.
- **Lockfile (`tas.lock.json`)** records the last synced hash per prompt and per profile, so one repo can mirror to several platforms. Repointing a profile at a different platform resets its section.
- **Fetched prompts are cached for 60 seconds** by default; a stale copy is served if a refresh fails.

## Archiving and deletion

- **Retiring a prompt is done with `archived: true` in its file**, not by deleting it. Archiving is an ordinary new version; removing the flag restores the prompt. Nothing is deleted on any platform.
- **The SDK refuses to serve an archived prompt** (`PromptArchivedError`) unless `allowArchived: true` is passed, whether it comes from bundled files or the platform.
- **Only `archived: true` is valid.** `archived: false` is rejected so "not archived" has one spelling.
- **The flag lives in the envelope on every platform** and is mirrored as an `archived` tag for filtering in the vendor UI. *Caveats:* the tag `archived` cannot be used as a user tag on an archived prompt; removing the mirrored tag in a vendor UI does not unarchive, because the envelope is the truth here (an exception to "vendor UI edits win").
- **A prompt the adapter cannot represent is reported as `unreadable`**, with the reason, and is skipped by both `push` and `pull` even with `--force`. The rest of the project syncs normally.
- **Sync detects deletions through the lockfile.** A prompt synced before and now missing on one side is "deleted locally" or "deleted on platform"; one never synced is simply new.
- **Deletion follows the canonical rule.** Repo canonical: a locally deleted prompt is not pulled back; a prompt deleted on the platform is pushed back. Platform canonical: a prompt deleted there is not pushed back and `pull` removes the local file; a locally deleted file is restored by `pull`. `--force` overrides.
- **Sync never deletes on a platform.** A locally deleted prompt stays on the platform until `tas prompts delete <name> --yes`, which removes every version there, the local file and the lock entry. Without `--yes` it only lists. *Caveat:* platform deletion is permanent (verified live on all three).
- **Deletion detection depends on the lockfile.** If `tas.lock.json` is lost or not committed, deleted prompts look new again and will be recreated.

## Invocation

Pinned by `test/run.test.ts`. Verified live on 2026-11-17 against a local Ollama model (`test/gateway.live.test.ts`): plain run, structured output, a tool round-trip and chat. The Braintrust gateway accepted the request and key but had no provider configured, so no hosted gateway has returned a completion yet.

- **One wire format: OpenAI chat completions.** `run` posts to `<gateway.baseURL>/chat/completions`. Any gateway or provider that speaks it works; nothing else does. *Caveat:* provider-specific features outside that format (Anthropic-native tools, the OpenAI Responses API) are not reachable.
- **The prompt drives the call.** Model, settings, tools and output schema come from the prompt; per-call `model`, `params`, `output` and `tools` override them.
- **`gateway.models` maps model ids per gateway**, so switching gateway never means editing prompts.
- **Streaming is a separate call, not a flag.** `stream()` returns something to iterate (`text` for words, or events: `text`, `tool-call`, `tool-result`) plus a `result` promise that resolves to exactly what `run()` returns. Tool loops, structured output and tracing behave the same as in `run()`. Verified live against a local model.
  - Structured output is validated when the stream ends, so a stream can deliver text and then fail validation. Partial JSON is not parsed for you.
  - A failure reaches both the iterator and `result`.
  - One iterator per stream: events are queued for a single consumer.
  - An endpoint that ignores the request to stream still works: its whole reply arrives as one piece.
  - `chat` sessions have `send` and `stream`.
- **Model calls are retried** on network failures, 408, 425, 429 and 5xx: 2 extra attempts by default (`gateway.retries`), exponential backoff with jitter from 500 ms, honouring `Retry-After`, never waiting more than 8 seconds at a time. Other 4xx statuses are not retried. *Caveats:* a retried request is sent again in full, so the provider may bill a call that timed out on our side; a stream is only retried before its first byte.
- **Prompt registry calls (push, pull) are not retried.** A push is not safe to repeat blindly.
- **Structured output is validated.** With an output schema, the reply must be JSON that passes it, or `OutputValidationError` is thrown (it carries the raw text). Without a schema, `output` is undefined.
- **A schema passed to the call replaces the prompt's.** It may be plain JSON Schema (validated with TypeBox) or any Standard Schema validator (output type inferred). A validator that cannot produce JSON Schema is still usable when the prompt has a schema to show the model; otherwise the call fails before reaching the gateway.
- **Which schema libraries work on their own:** checked on 2026-11-17, zod 4 implements both halves of Standard Schema (validation and JSON Schema conversion), so a zod schema works anywhere. Valibot's core package implements validation only, so a Valibot schema needs the prompt to carry an output schema, or its separate JSON Schema converter. Not pinned by a test, since neither library is a dependency.
- **Tools run only when you supply a function.** A tool call with no function ends the run and is returned in `toolCalls`, with nothing half-executed.
- **Bad tool arguments go back to the model** as an error message so it can correct itself; **an error thrown by your function propagates** to you. The first is the model's mistake, the second is the application's.
- **Tool loops are capped** by `maxSteps` (default 8 model calls), then `ToolLoopError`.
- **A text prompt is sent as one user message.**
- **`chat` renders the prompt once** and continues from the last reply; a failed turn leaves the conversation unchanged.
- **Everything that makes a prompt unusable fails before the gateway is called:** archived, non-portable template syntax, missing variable, no model, no gateway.
- **There is no separate agent abstraction.** `run` with tool functions is the agent loop; anything heavier belongs in a real agent framework.

## Tracing and masking

Pinned by `test/trace.test.ts`. Verified live on 2026-11-17: one traced, masked, tool-using run was exported to all three platforms at once and read back from each through its API.

- **We implement the OpenTelemetry wire format ourselves** (about 250 lines: spans encoded as OTLP JSON and posted with `fetch`) instead of depending on the official OpenTelemetry SDK. All three platforms accept OTLP JSON over HTTP (verified live), so no protobuf is needed. The official packages have a clean advisory record but bring roughly ten packages, and the exporter is still 0.x. *Caveat:* spans created by an application's own OpenTelemetry setup (HTTP, database) do not nest with ours, and ours do not appear in theirs. A separate optional bridge package is the planned answer for teams already on OpenTelemetry.
- **One span shape for every platform**: `span`, `generation` (a model call) or `tool`, with input, output, metadata, model, settings, token usage and the prompt that produced it. Each adapter translates it into that platform's attribute names.
- **`run` and `chat` are traced automatically**: one span per run named after the prompt, one per model call, one per tool execution. `client.trace()` groups them and adds your own spans.
- **A block's return value is recorded as its output** unless the block sets one.
- **Masking runs once, in-process, before any exporter**, on inputs, outputs, metadata and error messages. Every platform receives the same masked data. *Caveat:* masking affects only what is exported; the model and your application still see real values.
- **Not masked, by decision:** user id, session id, tags, span names and model names. Do not put sensitive data in them.
- **`capture: { input: false, output: false }`** drops content from a span and everything under it; token counts and timing are kept.
- **User, session and tags are set on the root span and inherited** by every span below.
- **Traces go to `platform` by default.** `tracing: [a, b]` sends the same spans to several platforms (dual-write while switching vendor); `tracing: false` turns it off.
- **Export never breaks the application.** A platform that is down or rejects spans is reported through `onTraceError` (default: a console warning). A failed batch is retried twice in the background modes (`traceExport.retries`), then dropped. In `blocking` mode it is not retried unless you ask, since each attempt would add to your response time.
- **Tracing must not slow the traced application.** Recording a span does no network work; by default spans are sent in the background. Three modes, set with `traceExport.mode`:
  - **`buffered` (default):** batches, sent after 2 seconds or 50 spans. Application code never waits. *Caveat:* a short-lived process must call `client.flush()` before exiting or the last spans are lost.
  - **`immediate`:** each trace is sent, as one request, when its outermost span ends, still in the background. Sooner visibility and a smaller loss window; application code still never waits.
  - **`blocking`:** as `immediate`, but the outermost `trace()` or `run()` call does not return until the platforms have answered. This deliberately adds their response time to yours, and exists for runtimes that freeze the process when a handler returns. Inner spans never wait.
- **A platform that does not answer is abandoned after `traceExport.timeoutMs`** (default 10 seconds), so neither a blocking call nor a shutdown `flush()` can hang.
- **Masking and copying are the tracing costs paid inline.** When a span ends, its input, output and metadata are masked, or copied if there are no masking rules, so the trace records the values as they were and later changes to the same objects cannot leak in. This is synchronous CPU work on the request path, proportional to payload size; `capture: false` avoids it. *Caveat:* values JSON cannot express (functions, class instances) are dropped or flattened.
- **Each client has its own tracer.** Tenants never share exporters, masking rules or trace ids; a span opened by one client is not a parent for another's.
- **Each chat turn is its own trace.** Pass `trace.sessionId` to group a conversation on the platform.
- **Prompt identity in traces:** every span carries `tas.prompt.name` and `tas.prompt.hash`, which survive a vendor switch. A platform's own prompt link (Langfuse prompt version, LangSmith hub commit) is set only when that platform served the prompt. *Caveat:* with repo-canonical prompts there is no platform version, so the vendor UI will not link traces to its prompt page.
- **Platform differences seen live:** Braintrust also copies unrecognised attributes into metadata, so user and session appear twice there; LangSmith assigns its own trace ids, so an id from `span.traceId` cannot be used to look a trace up in LangSmith.
- **Scores cannot be attached to live traces.** They exist only on evaluation runs.

## Evals

Pinned by `test/eval.test.ts`. Verified live on 2026-11-17: the same three-item run, including an errored item and score comments, was stored as an experiment on all three platforms, twice against the same dataset.

- **The task and the scorers always run in your process.** Platforms only store the result, so numbers do not change with the vendor. *Caveat:* platform-side evaluators (LLM judges configured in a vendor UI, online evals) are not used or triggered.
- **A score is a number from 0 to 1.** Booleans count as 1 or 0; `null`/`undefined` means "does not apply" and is left out of the mean. Anything else, including out-of-range numbers, is recorded as an error for that scorer on that item. The range is Braintrust's hard limit (verified live), adopted everywhere so a run is portable.
- **Scorers are plain functions** `({ input, output, expected, metadata }) => score`, named by their key in `scorers`. The same shape as `autoevals`, so those work unchanged. Built in: `exactMatch`, `includes`, and `judge`, which runs an ordinary prompt as an LLM judge.
- **One failing item never stops a run.** A task that throws marks the item as errored and skips its scorers; a scorer that throws loses only its own score for that item. Errors are counted in the summary but only `thresholds` make a run fail.
- **Results are returned even if reporting fails**; each platform's outcome is in `result.reports`.
- **Datasets are JSONL files** (`<name>.dataset.jsonl`, one item per line), or plain arrays in code. Reporting a run creates or updates the dataset on the platform.
- **Datasets sync in both directions with explicit commands**, `tas datasets pull|push|list` (verified live on all three, including non-object inputs and a pull after an experiment). There is no lockfile and no canonical side for datasets:
  - *Pull:* the platform's version of an item wins; the file keeps its order; new items are appended; rows only the file has are kept. Pull never deletes a row from your file.
  - *Push:* items are upserted by id. A row removed from the file stays on the platform. Push never deletes there.
  - An id that is only the hash of the input is not written to the file.
  - *Caveat:* Braintrust can take a second or two to show dataset rows that were just written (seen live: a pull straight after a push sometimes missed the newest row). A pull that looks short right after a push is worth repeating.
  - *Caveat:* because nothing is ever deleted by sync, removing an item everywhere means deleting it in the vendor UI and in the file.
- **Item ids default to a hash of the input**, so the same item is recognised across runs and platforms upsert instead of duplicating (verified live on all three). Two items with the same input need explicit ids.
- **Every run gets a unique name** (`<name>-<timestamp>`), so a re-run never overwrites an earlier experiment.
- **Each item runs inside its own trace tagged `eval`.** *Caveat:* if tracing is on, eval traffic lands in the same place as real traffic, distinguishable only by that tag and its metadata.
- **`tas eval <files>`** runs `*.eval.ts` files against the configured client and exits 1 when a threshold is missed, for use in CI.
- **How each platform stores a run:**
  - *Braintrust:* a dataset (rows upserted by id) and an experiment whose rows link back to it. Score comments and scorer errors go in row metadata. The result includes the experiment URL.
  - *Langfuse:* a dataset and items, then one trace per item carrying experiment attributes, then scores on those traces. There is no REST call to create a run. No URL is returned.
  - *LangSmith:* an ordinary dataset, a session bound to it, one run per row bound to its example, and feedback per score, which is how LangSmith's own SDK records experiments. Its one-call experiment upload is not used: it only accepts datasets it created itself, which could then not be pushed to or edited normally (found live). Inputs and outputs must be objects, so other values are wrapped as `{ input: ... }` / `{ output: ... }`, and the wrapping is remembered so a pull returns the original value. A run must end after it starts, so an instant task's end time is nudged by a millisecond. No URL is returned. *Caveat:* it uses LangSmith's v1 sessions endpoint, which LangSmith has announced it will remove on 2027-07-01.
  - *Item ids on each platform:* Braintrust uses ours directly. Langfuse ids are unique per project, so ours are prefixed with the dataset name and the prefix is removed on pull. LangSmith needs UUIDs, so ours are hashed into one and the original is kept in the example's metadata.
- **Langfuse datasets cannot be deleted through its API**, so the cleanup script leaves them for the UI.

## Studio and portability checks

Pinned by `test/studio.test.ts`.

- **`checkPortability(prompt)` says, from the prompt alone, what each platform would not store natively**: no network and no configuration, so it covers all three platforms whichever one you use. Three levels: *error* (cannot be stored there, or anywhere), *warning* (stored and round-trips, but behaves differently on that platform, typically in its playground), *info* (kept in metadata; your code is unaffected). `tas prompts check` prints it and exits 1 on an error. *Caveat:* it restates what the adapters do, in one file (`src/portability.ts`); when an adapter changes what is native, that file has to change with it.
- **`tas studio` is a local page over the prompt files.** It reads and writes the same `*.prompt.yaml` files as everything else and keeps no state of its own. It offers live validation, variables, the per-platform notes above, sync status with push and pull, a preview of the rendered messages, and a test run through the gateway.
- **The editor is the YAML itself**, not a form, so nothing the format can express is out of reach and what you see is what is saved. Saving rewrites the file the way the SDK writes it (validated, keys in a fixed order). *Caveat:* comments in a hand-written prompt file are lost when it is saved from the studio.
- **A save that does not validate is refused** and leaves the file as it was.
- **Deleting in the studio deletes the file only.** Removing a prompt from a platform stays an explicit CLI command.
- **"Run" makes a real, billable model call**, always with the saved file, never with unsaved text. It is offered only when a gateway is configured.
- **The server protects itself, because it can write files and use your platform credentials:** it listens on the loopback address only; it answers only when the request's Host header is that address (which blocks DNS rebinding); and every API call must carry a token that exists only in the page it served (which stops other sites open in the same browser). There is no login: anyone who can use your machine as you can use the studio.
- **No build step and no front-end dependencies**: the page is one HTML string with inline styles and script.

## Multi-tenancy

- **A client is self-contained** (platform, gateway, masking, cache). There is no global default client.
- **`createClientPool`** creates one client per tenant on demand, least-recently-used eviction, failures not cached.
- **`withClient`** scopes a client to a request. Calling `currentClient()` outside one throws.

## Emulation ("the envelope")

- **Anything a platform cannot store natively goes into a reserved `__tas` object** in that platform's free-form metadata. It may look odd in the vendor UI; application code is unaffected.
- **Edits made in a vendor UI win** over envelope contents wherever the two can disagree.
- **The key name `__tas` is permanent once real prompts exist**: renaming it would orphan stored data.
- **Every adapter passes one conformance suite**, run against a fake server offline and the real service on demand: round-trip of every field, no new version when nothing changed, immutable versions, movable labels.

## Braintrust

- **The adapter never creates projects**; a missing project is an error.
- **A prompt's Braintrust slug is its name, `/` included** (verified live with a push, pull and re-push of nested names). The slug is the identity; a prompt made in the Braintrust UI can have any display name.
- **Placeholders are emulated** (Braintrust has no placeholder message); the native message list omits them.
- **Tools on a text prompt are emulated**; Braintrust completion prompts have no tools field.
- **Braintrust drops parameters the model does not support** (verified live: `temperature` on `gpt-5`). The intended set is kept in the envelope and restored on read.
- **Labels are Braintrust environments**, which are org-wide and must already exist. Pushing to an unknown label fails.
- **A prompt in template format `none` containing `{{` is rejected** as not portable.
- **Roles other than system/user/assistant, and message parts other than text, image and file (audio, for example), are rejected** as not portable. The same holds on Langfuse and LangSmith.
- **Environment assignment uses endpoints outside Braintrust's published API spec** (verified live, but more likely to change).

## Langfuse

- **Model settings, tools and output schema go in `config`** in OpenAI-style layout, which the Langfuse playground reads.
- **Description and metadata are emulated**; a Langfuse prompt has no field for either.
- **Default fetch differs:** Langfuse serves `production` when no label is given; the SDK asks for the newest version instead.
- **Prompt type is fixed at creation.** Changing chat to text (or back) fails.
- **Tags are kept per version** although Langfuse stores one tag list per prompt. Each version's tags are saved with it; the newest version reads Langfuse's own list, so a tag edited in the Langfuse UI is still picked up.
- **Config with no model** is carried in `metadata["langfuse.config"]` and written back unchanged.
- **Prompt references (composition)** are returned already expanded (verified live). Pushing a changed copy would replace the references with their text, so the adapter refuses without `force`.

## LangSmith

- **Names must start with a letter and cannot contain `--`**, because `/` is stored as `--` and handles allow only `[a-z0-9_-]` (verified live).
- **Prompts are written as LangChain manifests in mustache format.**
- **Model, tools and output schema are native**, in the structure the playground writes (derived from ~100 public hub prompts, then verified live through the API's own `model_provider` / `model_config`). *Caveat:* how the playground UI renders them has not been checked by eye.
- **Provider is inferred from the model id** (known prefix, then model family, else OpenAI-compatible). `resolveModel` overrides it.
- **Seven settings are real model arguments** (`temperature`, `max_tokens`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `reasoning_effort`); other params stay in the envelope and have no playground control.
- **API keys are written as references to workspace secrets**, never values.
- **Tools need a model**; without one they stay in the envelope. **Output schema is native for chat prompts only.**
- **Azure OpenAI prompts can be read but not written.**
- **Description and tags are repo-wide in LangSmith.** The per-version copy lives in the envelope; the repo copy is a mirror for readability.
- **LangSmith adds its own tag** (the manifest class name), which is filtered out.

## Development process

- **Unit-test coverage has a floor that fails the build**: 96% of statements, 98% of lines, 95% of functions, 89% of branches (`pnpm coverage`). Measured on 2026-11-17: 97.0 / 99.1 / 95.9 / 90.1. Only offline tests count; the live suites add nothing to it.
- **The CLI is a function, `runCli(argv, io)`**, with `bin.ts` as a one-line executable around it, so commands are tested in-process and count towards coverage.
- **Live tests are opt-in:** `pnpm test:live`, with credentials in `.env`. Plain `pnpm test` never touches a vendor.
- **The live invocation test needs any OpenAI-compatible endpoint** (`TAS_LIVE_GATEWAY_URL`, `TAS_LIVE_GATEWAY_MODEL`); a local Ollama is enough and costs nothing. It asserts on what the SDK did, not on the model's wording.
- **Live tests leave prompts behind** under a `tas-live-<timestamp>/` prefix. `pnpm cleanup:live` removes them and is run on request, not automatically.

## Open questions

- Whether to allow hyphens in variable names.
- Package name is `@traceandscale/sdk`; the CLI is `tas` and the metadata key `__tas`.
