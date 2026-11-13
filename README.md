# navno-logger

Logging in dev and Nais with bonus features:

- Automatic pino-pretty in dev
- Automatic Nais-contract logging when deployed
- Cleaner stack traces
- `console.log` compatible log-calls instead of Pino's

## Install

```
pnpm add @navikt/navno-logger
pnpm add -D pino-pretty
```

## Use

```ts
import { logger } from '@navikt/navno-logger';

logger.info('Listening on port', 3001);
logger.error('Search failed', { status: 500 }, err);
```

> [!NOTE]
> `LOG_LEVEL` sets the lowest level written - which is `info` by default.

## Output

When `NODE_ENV=production`, one JSON line per call, in the shape Loki and Nais APM parse.

```json
{
	"level": "error",
	"time": "2026-11-10T21:34:05.220Z",
	"trace_id": "…",
	"span_id": "…",
	"status": 500,
	"err": { "type": "Error", "message": "…", "stack": "…" },
	"stack": "Error: …",
	"message": "Search failed"
}
```

When running locally readable lines:

```
22:34:16 WARN: Invalid search-url term
22:34:16 ERROR: Search failed
    status: 500
    facet: "privatperson"
```

## In tests

Under Vitest (which sets `VITEST`), the logger calls `console.debug`, `.info`, `.warn` and `.error` with the
arguments as given, instead of writing through pino. Vitest catches console per test, so `silent: 'passed-only'`
shows the logs of a test that fails and hides the rest:

```ts
// vitest.config.ts
export default defineConfig({ test: { silent: 'passed-only' } });
```

`LOG_LEVEL` still sets the lowest level written, and `vi.spyOn(logger, 'error')` works as before. There is no JSON
or pino-pretty output under Vitest, whatever `NODE_ENV` is.

A process started from a test inherits `VITEST`, so a server spawned there logs through console as well. Leave
`VITEST` out of its env to get the usual output.

## Trace IDs

`trace_id` and `span_id` come from the active OpenTelemetry span, which the NAIS agent creates when the app has
`autoInstrumentation` enabled. There is nothing to set up in the app.

The span is read straight from the registry that the agent's copy of `@opentelemetry/api` keeps on `globalThis`,
not through a copy of that package of our own. A copy with a newer minor version than the agent's doesn't see the
agent's spans, and the lines then lose their `trace_id` without any error; with no copy there is no version to keep
in step.

That registry is how copies of `@opentelemetry/api` 1.x find each other, but it is not a documented API. The tests
open a span through the real package, a devDependency that dependabot keeps current, so a change to the registry
fails here first.

## Develop

`pnpm dev` prints a sample of every level through the logger, and prints it again when `demo.ts` or
`src/index.ts` is saved.

To compare with plain pino, `demo-vanilla-pino.ts` runs the same scenarios written the way pino wants them
(`(object, message)`, errors under `err`): `pnpm dev:pino` prints raw JSON, `pnpm dev:pretty` pipes it through
pino-pretty.

## Release

Bump `version` in `package.json` in a pull request. Merging it to main publishes that version to GitHub Packages.
