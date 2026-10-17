# Contributing to BaiSet

Contributions should preserve the security-first scope and keep domain rules in `packages/core` free of framework and database dependencies.

Before opening a change, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm audit
```

Add or update tests for domain behavior. Avoid putting personal data in fixtures, logs, or error messages. Legal requirements need authoritative verification and must not be guessed.
