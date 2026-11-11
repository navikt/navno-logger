# navno-logger

Logging for the navno team's Node servers: [pino](https://getpino.io) set up for NAIS, called like `console` and
readable in development. The setup is the one in [`@navikt/pino-logger`](https://github.com/navikt/next-logger),
so check there when NAIS changes what it expects of logs.

## Install

```
pnpm add @navikt/navno-logger
pnpm add -D pino-pretty
```

`@navikt` packages come from GitHub Packages, so `.npmrc` needs `@navikt:registry=https://npm.pkg.github.com`.
`pino-pretty` is optional: without it, the development logs are JSON too.

## Use

```ts
import { logger } from '@navikt/navno-logger';

logger.info('Listening on port', 3001);
logger.error('Search failed', { status: 500 }, err);
```

There is `debug`, `info`, `warn` and `error`. Each takes text, objects and errors in any order: the text becomes the
message, the objects' properties become fields, and an error is logged under `err`. `LOG_LEVEL` sets the lowest
level written, `info` by default.

Keep the message a fixed string and put what varies in a field. Nais APM groups errors by their message, so a
message with an ID in it becomes one issue per ID.

## Output

With `NODE_ENV=production`, one JSON line per call, in the shape Loki and Nais APM parse. Spread out here to read:

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

The stack is at the top level as well as under `err`, because that is where the Issues tab in Nais APM reads it.

Anywhere else, readable lines:

```
22:34:16 WARN: Invalid search-url term
22:34:16 ERROR: Search failed
    status: 500
    facet: "privatperson"
```

Every stack is cleaned up, in production too: Node's own frames are left out, and the paths are relative to the
working directory. The readable lines also dim the frames from `node_modules`; the JSON never has colours.

A server build that bundles its dependencies leaves `pino-pretty` out, as long as the bundler replaces
`process.env.NODE_ENV` with `"production"` (Vite: `define`).

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

## Release

Bump `version` in `package.json` in a pull request. Merging it to main publishes that version to GitHub Packages.
