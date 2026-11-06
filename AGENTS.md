# Astral Hub contributor guide

Read README.md and docs/architecture.md before changes. Use Node >=24; native Pi tests use Node 26.7.0 and SDK 1.4.0.

## Validation

```sh
npm ci
npm test
npm run build
node scripts/brand-icons.mjs --check
```

Computer runtime tests install dependencies in `agent` and run `npm --prefix agent run terminal:setup`. Platform packages must pass the complete workflow, Android emulator tests and signature/architecture/checksum verification before a Release is published.

## Boundaries

- Never commit secrets, `.env`, device credentials, signing keys, databases, runtime data, build outputs or personal screenshots.
- Preserve account/device/project ownership, path and symlink checks, read-only grants, cancellation and receipt idempotency.
- Keep server and computer execution targets distinct. A computer command is not a project-directory sandbox.
- New user-facing software operations must also integrate with `app_functions`, including scoped discovery, argument validation, permission checks, exact confirmation where needed and tests.
- Keep local/remote composer controls shared and verify narrow/light/dark layouts.
- Never fabricate model results, usage, signing evidence or successful delivery. Separate unit fixtures, real model calls, emulator checks and physical-device validation.
- Do not automatically replay unknown commands or messages. Preserve existing data and never restore an old database over new user work.
- Public CI must not fetch private source or expose private signing material in caches/artifacts/logs. Pull requests receive no signing secrets or release-write permission.
- Record changes and validation in Git. Check fresh command output before claiming completion.
