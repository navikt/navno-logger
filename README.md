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

It has pino's six levels, lowest first: `trace`, `debug`, `info`, `warn`, `error` and `fatal`.

> [!NOTE]
> `LOG_LEVEL` sets the lowest level written - which is `info` by default.

### How a call becomes a line

Call it like `console.log`. Arguments can come in any order, so pino's own `(object, message)` also works.

| Argument                                   | Ends up                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| The first string                           | The message, and a format string: `('Port %d', 3001)`           |
| Other text, numbers, `undefined`, …        | Added to the message with spaces, printed the way console does  |
| Arrays, Dates, Maps, URLs, class instances | Added to the message, printed the way console does, on one line |
| Plain objects `{ status: 500 }`            | One field per key                                               |
| An `Error`, or `{ err }` as pino takes it  | `err` and `stack`, with Node's own frames left out              |
| Another `Error`                            | Added to the message as `TypeError: no hits`                    |

A field named `level`, `time`, `message`, `err` or `stack` gets a `_` in front (`_message`) so it can't replace
the logger's own key.

### Module format

The package is ESM only and uses top-level `await` to load pino-pretty. This means `require()` won't work, not even
with Node's `require(esm)`, and a bundler has to support top-level `await`. Its types are found with
`moduleResolution` set to `nodenext`, `node16` or `bundler`.

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
arguments as given, instead of writing through pino. `trace` goes to `console.debug` and `fatal` to
`console.error`, as console has no `fatal` and its `trace` prints a stack. Vitest catches console per test, so `silent: 'passed-only'`
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

### Route names in Hono

The agent can't tell Hono's routes, so its spans are named after the method alone. `traceRoute` gives the span of
the request being handled its route, and does nothing outside a request or without the agent:

```ts
import { traceRoute } from '@navikt/navno-logger';
import { routePath } from 'hono/route';

app.use(async (c, next) => {
	await next();
	traceRoute(routePath(c));
});
```

## Develop

`pnpm dev` prints a sample of every level through the logger, and prints it again when `demo.ts` or a file in
`src` is saved.

To compare with plain pino, `demo-vanilla-pino.ts` runs the same scenarios written the way pino wants them
(`(object, message)`, errors under `err`): `pnpm dev:pino` prints raw JSON, `pnpm dev:pretty` pipes it through
pino-pretty.

## Release

Bump `version` in `package.json` in a pull request. Merging it to main publishes that version to GitHub Packages.
