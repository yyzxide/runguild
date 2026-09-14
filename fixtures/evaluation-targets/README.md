# RunGuild bounded evaluation targets

These dependency-free Node.js fixtures provide three small task families for
paired real-model Evaluation. They are deliberately incomplete at baseline:
the public smoke test passes while the protected acceptance test fails until an
Agent changes implementation code.

Materialize a fresh standalone Git repository outside RunGuild:

```bash
node scripts/materialize-evaluation-target.mjs local-bug /tmp/runguild-local-bug
```

Each target uses `npm test` and `npm run typecheck`. Configure
`test/acceptance.test.mjs` as a protected path and run the commands through the
declared Bubblewrap policy. Never use the failing fixture directories directly
as a RunGuild project repository.

Task families:

- `local-bug`: one-function normalization bug;
- `api-implementation`: one pure HTTP-routing contract;
- `cross-module`: one policy field propagated through parser and report modules.
