# CLAUDE.md

## Pre-commit checklist (ALWAYS do all of these before committing)

1. `bun run --filter '@zojize/dead-drop' build` — build core
2. `bun run lint` — zero errors (autofix with `bun run lint:fix`)
3. `bun run typecheck` — typecheck all packages
4. `bun run knip` — no unused deps/exports
5. `bun run test` — all tests pass
6. `cd playground && bunx vite build` — playground builds
7. Check README for stale documentation

## Post-push checklist

- Wait for CI (`gh run list --limit 2`) and confirm both CI and Deploy are green
- Do NOT tell the user CI passed without actually checking

## Publishing pipeline (automated via Release Please)

Publishing is handled by [Release Please](https://github.com/googleapis/release-please-action).
The workflow lives at `.github/workflows/release-please.yml`.

### How it works

1. Write conventional commits (`feat:` = minor, `fix:` = patch, `feat!:` or `BREAKING CHANGE` = major)
2. On push to `main`, Release Please opens/updates a **release PR** with version bump + changelog
3. **Merging that release PR** triggers: GitHub release creation + `npm publish`
4. No manual version bumps, tags, or npm commands needed

### Config files

- `release-please-config.json` — declares `packages/core` as a node release type
- `.release-please-manifest.json` — tracks current version (auto-updated by Release Please)

### Setup requirement

The npm token must be stored as a GitHub Actions secret named `NPM_TOKEN`:
- Settings > Secrets and variables > Actions > `NPM_TOKEN`

### Manual publishing (fallback)

If Release Please is broken or you need to publish manually:

1. Bump version in `packages/core/package.json`
2. `cd packages/core && npm pack --dry-run` — inspect tarball contents, verify no `.env`, credentials, or unexpected files
3. Read `.env` for npm automation token
4. `echo "//registry.npmjs.org/:_authToken=<TOKEN>" > ~/.npmrc`
5. `cd packages/core && npm publish --access public`
6. `rm ~/.npmrc` — clean up token immediately
7. `git tag vX.Y.Z && git push origin vX.Y.Z`
8. `gh release create vX.Y.Z` with changelog

## Architecture

- **Monorepo**: `packages/core` (library + CLI) and `playground` (Vite + React)
- **Dynamic tables**: No fixed lookup table. Table is rebuilt per-position from context (scope, inFunction, inLoop, inAsync). Hash mixes consumed bytes for deterministic shuffle.
- **All data in AST structure**: Literal values (names, strings, numbers) are cosmetic. `decode()` takes only a string — no options.
- **Expression + statement encoding**: Unified candidate pool filtered by context. Expressions wrapped in ExpressionStatement in statement position.
- **Iterative**: Encoder, decoder, codegen all use explicit work stacks. No recursion.

## Key rules

- Never commit `.env` or npm tokens
- Never use `errorRecovery` or `allowReturnOutsideFunction` in decoder — generated JS must be valid
- Pool values must be unique within a pool (duplicates break bijective reverse lookup)
- The running structural hash must be identical in encoder and decoder — seed only affects cosmetic PRNG
- Block count bytes use raw values (decoder recovers from `stmts.length`)
- UpdateExpression is a leaf (operand must be LVal — use cosmetic identifier)
- The `$` character must not appear in pool names (conflicts with scope-suffix separator)
