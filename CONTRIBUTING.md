# Contributing

Thanks for considering a contribution! A few ground rules.

## Bug reports

Open an issue with:
- the gateway version (`git rev-parse HEAD`)
- the endpoint you hit + minimal request body
- the response you got + the response you expected
- relevant audit-log row from `llm_calls` (redact prompts if sensitive)

## Pull requests

1. Branch from `main`.
2. Build cleanly: `npm install` then `npm --workspace=packages/gateway run build`.
3. The build-drift guard refuses to start the server if `src/*.ts` is newer than
   `dist/*.js` — always rebuild before testing.
4. Run `npm test` in any package you touched.
5. For new routing rules: add an example caller in your PR description and a
   one-line entry in `packages/gateway/src/config/routing-rules.yaml`.
6. For new subscription bridges: copy an existing bridge (e.g. `openai-bridge/`)
   and adapt the auth + request-shape logic. Add a catalog entry in
   `packages/gateway/src/modules/subscription-discovery.ts` so auto-discovery
   can find it.

## Security-sensitive areas

- `packages/gateway/src/pipeline/*` — pre-classifier and post-validator. Be
  extra careful here; these are the prompt-injection guards.
- `packages/gateway/src/modules/admin-auth.ts` — token validation for dashboard
  endpoints.
- `packages/gateway/src/observability/audit-log.ts` — writes every call to the
  database. Logging changes must preserve compression metadata.

If you find a security issue, please follow [`SECURITY.md`](SECURITY.md)
instead of opening a public issue.

## Code style

- TypeScript strict mode is enforced.
- Prefer immutable data structures.
- No `any`. Use `unknown` + narrowing.
- Functions under ~50 lines; files under ~800 lines.
