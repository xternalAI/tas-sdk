# For coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md): the rules there apply to you exactly as written. In short:

- `pnpm typecheck && pnpm test` after every change; `pnpm coverage` before you finish.
- A behaviour change means three edits together: the code, its test, and its entry in `docs/decisions.md`.
- No new runtime dependencies. No credentials read from the environment in `src/`.
- Never run `pnpm test:live` or `pnpm cleanup:live` unless asked: they create and delete real things on vendor accounts.
- [docs/architecture.md](docs/architecture.md) maps the modules; every file's first comment says what it owns.
