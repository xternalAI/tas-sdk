# Contributing

For people and for coding agents; the rules are the same. Start with
[docs/architecture.md](docs/architecture.md) for the map.

## Commands

```bash
pnpm install
pnpm typecheck        # tsc, no output means clean
pnpm test             # offline tests, about a second
pnpm coverage         # the same, with thresholds that fail the run; open coverage/index.html for the report
pnpm lint             # biome: formatting and lint
pnpm format           # apply formatting
pnpm build            # emit dist/ for publishing
pnpm tas <command>    # run the CLI from source
node scripts/smoke-package.ts   # after a build: pack, install into an empty project, import and run it
pnpm test:live        # against the real services; needs credentials in .env, see the *.live.test.ts files
pnpm cleanup:live     # delete what live tests left behind (add --dry-run to look first)
```

Node 22.18 or newer. The code runs from TypeScript source directly; there is no build step in development.

## Rules

1. **Every design decision goes in [docs/decisions.md](docs/decisions.md), and gets a test.** That
   includes things we deliberately flag, refuse or do not handle. If you change such a behaviour,
   change its entry and its test in the same commit. Tests that exist only to pin a decision live in
   `test/decisions.test.ts`.
2. **Do not add a runtime dependency without discussing it first.** Vendor APIs are called with
   `fetch`; small things are written here. Dev dependencies are fine.
3. **Platform behaviour is verified, not assumed.** Vendor docs have been wrong or silent often
   enough that anything an adapter relies on should be probed against the live API, recorded in
   `docs/platform-mapping.md`, and reproduced in the fake server in `test/fakes.ts`.
4. **Credentials are passed explicitly**, never read from the environment inside `src/`.
5. **Coverage does not go down.** `pnpm coverage` enforces the floor.
6. **Live tests create real things.** They are opt-in, name everything `tas-live-...`, and never run
   as part of `pnpm test`. Run `pnpm cleanup:live` afterwards.

## Style

- Each file starts with a comment saying what it is responsible for. Exported things have a doc
  comment; so does anything whose reason is not obvious. Comments explain *why*, especially when
  the why is a vendor quirk.
- Small named functions over long ones. If a function needs section comments, split it.
- Errors a user can fix say what to do. Failures are loud: nothing is silently dropped.
- Tests read as documentation: the test name states the behaviour, in the user's terms.
- Imports use explicit `.ts` extensions.

## Adding a platform adapter

1. Create `src/adapters/<name>/` with `index.ts` exporting a factory that returns a `PlatformAdapter`.
2. Start with `prompts.ts`. Add a fake server to `test/fakes.ts`, run `conformance()` against it in
   `test/adapters.test.ts`, and make it pass.
3. Add `test/<name>.live.test.ts` and make the same suite pass against the real service. Expect the
   real service to disagree with its docs; record what you find.
4. Add tracing, datasets and experiments the same way (`datasetConformance` exists for stores).
5. Add the platform to `src/portability.ts`, to `scripts/cleanup-live.ts`, and to `docs/decisions.md`.

## Releasing

Maintainers only. The version in `package.json` is the single source of truth; the tag, the GitHub
release and the npm version are derived from it by `.github/workflows/release.yml`.

1. Bump the version in a pull request: `npm version patch --no-git-tag-version` (or `minor` / `major`).
2. Merge it. The Release workflow runs the checks, submits the version to npm for approval and
   tags the commit `v<version>`.
3. Approve it on npmjs.com (Staged Packages) with 2FA, or with `npm stage list` and
   `npm stage approve <stage-id>`. Now it is live.
4. The GitHub release is created by the workflow's next run: the next push, the daily schedule, or
   Actions > Release > Run workflow.

Do not push version tags or run `npm publish` by hand. To abandon a staged version, reject it on
npm and bump the version; a tagged version is never submitted twice.

The protections around releasing (approval on the `npm` environment, rules for `main` and for
version tags, approval before outside pull requests run CI) are applied by `scripts/protect-repo.sh`.
