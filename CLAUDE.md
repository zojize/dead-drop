# CLAUDE.md

## Pre-commit checklist (ALWAYS do all of these before committing)

1. `bun run --filter '@zojize/dead-drop' build` — build core
2. `bun run typecheck` — typecheck all packages
3. `bun run knip` — no unused deps/exports
4. `bun run test` — all tests pass
5. `cd playground && bunx vite build` — playground builds
6. Check README for stale documentation

## Post-push checklist

- Wait for CI (`gh run list --limit 2`) and confirm both CI and Deploy are green
- Do NOT tell the user CI passed without actually checking

## Publishing pipeline

1. Bump version in `packages/core/package.json`
2. Read `.env` for npm automation token
3. `echo "//registry.npmjs.org/:_authToken=<TOKEN>" > ~/.npmrc`
4. `cd packages/core && npm publish --access public`
5. `rm ~/.npmrc` — clean up token immediately
6. `git tag vX.Y.Z && git push origin vX.Y.Z`
7. `gh release create vX.Y.Z` with changelog
8. Clean up old tags/releases

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
