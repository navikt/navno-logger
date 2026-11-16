import { styleText } from 'node:util';
import pino from 'pino';
import type { PrettyOptions } from 'pino-pretty';
import { serializeError, toPinoArgs } from './args.ts';

// What consumers see when they hover a method, so each says how a call becomes a line
type Log = (...args: unknown[]) => void;

/**
 * pino's levels, called like `console`: `logger.error('Search failed', { status: 500 }, err)`.
 *
 * Writes JSON lines for Nais in production, readable lines in development, and calls `console` under Vitest.
 * `LOG_LEVEL` sets the lowest level written, `info` by default.
 */
export interface Logger {
	/**
	 * Logs at `trace`, the lowest level, only written when `LOG_LEVEL=trace`.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.trace('Answer from search', { body });
	 */
	trace: Log;
	/**
	 * Logs at `debug`, only written when `LOG_LEVEL` is `debug` or `trace`.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.debug('Cache hit', { key: 'offices' });
	 */
	debug: Log;
	/**
	 * Logs at `info`, the lowest level written by default.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.info('Listening on port', 3001);
	 */
	info: Log;
	/**
	 * Logs at `warn`.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.warn('No office found for postnr', { postnr });
	 */
	warn: Log;
	/**
	 * Logs at `error`.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.error('Search failed', { status: 500 }, err);
	 */
	error: Log;
	/**
	 * Logs at `fatal`, the highest level: for when the server can't go on, just before it exits.
	 * pino writes out what it holds when the process exits, so `process.exit()` right after it doesn't lose the line.
	 * Called like `console.log`: text becomes the message (a first string with `%s`, `%d`, … is a format string),
	 * the keys of `{…}` objects become fields, and an `Error` goes under `err` with a cleaned-up stack.
	 *
	 * @example logger.fatal('Could not start', err);
	 */
	fatal: Log;
}

// Prints an error like Node would, with colors:
// - the name and message stand out
// - dependency frames are dimmed so the app's own frames are easy to find
// - `caused by` lines get their own color
// - extra properties (code, status, ...) are shown like any other object attribute
const prettifyError = (err: unknown) => {
	const { type, message, stack, ...props } = err as { type?: string; message?: string; stack?: string };
	const lines = (stack ?? `${type}: ${message}`).split('\n').map((line) => {
		if (/^\s+at /.test(line)) return /node_modules\//.test(line) ? styleText(['dim', 'italic'], line) : line;
		if (line.startsWith('caused by:')) return styleText(['yellow', 'italic'], line);
		return styleText(['red', 'bold'], line);
	});
	const extras = Object.entries(props).map(([key, value]) => `${styleText('cyan', key)}: ${JSON.stringify(value)}`);
	return [...lines, ...extras].join('\n');
};

// Help pino-pretty suck less
const PRETTY_OPTIONS: PrettyOptions = {
	messageKey: 'message',
	// err already shows the stack itself, go away pino
	ignore: 'stack',
	// `error` is often a plain string field, so we tell pino leave that alone
	errorLikeObjectKeys: ['err'],
	translateTime: 'SYS:HH:MM:ss',
	customPrettifiers: {
		// Dim the time, it's rare we care what time it was in dev
		time: (time) => styleText('dim', time as string),
		err: prettifyError,
	},
	// Fix some of pino-pretty's bonkers text color choices
	customColors: {
		trace: 'gray',
		debug: 'blue',
		info: 'green',
		warn: 'yellow',
		error: 'red',
		fatal: 'bgRed',
		message: 'reset',
		property: 'cyan',
	},
	sync: true,
};

// If pino-pretty isn't installed silently abort
const prettyStream = async () => {
	const pinoPretty = await import('pino-pretty').catch(() => undefined);
	return pinoPretty?.default(PRETTY_OPTIONS);
};

// We read the Nais copy of @opentelemetry/api so we don't have to keep some NPM package in sync with theirs
const REGISTRY = Symbol.for('opentelemetry.js.api.1');
const SPAN = Symbol.for('OpenTelemetry Context Key SPAN');
const REQUEST = Symbol.for('OpenTelemetry SDK Context Key RPC_METADATA');
type SpanContext = { traceId: string; spanId: string; traceFlags: number };
type Registry = { context?: { active(): { getValue(key: symbol): unknown } } };

// What the Nais agent keeps under a key for the request being handled, if anything
const fromAgent = (key: symbol) => (globalThis as { [REGISTRY]?: Registry })[REGISTRY]?.context?.active().getValue(key);

// Makes request traces work in Grafana, whenever the Nais agent has a span open
const traceIds = () => {
	const span = (fromAgent(SPAN) as { spanContext(): SpanContext } | undefined)?.spanContext();
	// All zeros means a span that belongs to no trace
	if (!span || /^0+$/.test(span.traceId) || /^0+$/.test(span.spanId)) return {};
	return { trace_id: span.traceId, span_id: span.spanId, trace_flags: `0${span.traceFlags.toString(16)}` };
};

/**
 * Names the span of the request being handled after its route, as `GET /sok/:id`, where the Nais agent can't tell
 * the route itself, as in Hono. Does nothing outside a request, or without the Nais agent.
 *
 * @example
 * app.use(async (c, next) => {
 * 	await next();
 * 	traceRoute(routePath(c));
 * });
 */
export const traceRoute = (route: string) => {
	const request = fromAgent(REQUEST) as { route?: string } | undefined;
	if (request) request.route = route;
};

// Under Vitest: console, which Vitest holds back per test, so `silent: 'passed-only'` shows a failing test's logs
// and hides the rest. pino writes past console, where Vitest can't tell which test a line came from.
// - console is looked up on each call, since Vitest swaps it in after modules may have loaded
// - the arguments are passed on as given, for Vitest to print
// - console has no fatal, and its trace prints a stack of where it was called: the nearest level it has stands in
// - a pino that writes nowhere says what the level lets through, so the level means what it does in production:
//   'trace' writes all, 'silent' none, and a level pino doesn't know throws
const CONSOLE = {
	trace: 'debug',
	debug: 'debug',
	info: 'info',
	warn: 'warn',
	error: 'error',
	fatal: 'error',
} as const satisfies Record<keyof Logger, 'debug' | 'info' | 'warn' | 'error'>;

const consoleLogger = (level: string): Logger => {
	const levels = pino({ level }, { write: () => {} });
	const write = (name: keyof Logger): Log =>
		levels.isLevelEnabled(name) ? (...args) => console[CONSOLE[name]](...args) : () => {};
	return {
		trace: write('trace'),
		debug: write('debug'),
		info: write('info'),
		warn: write('warn'),
		error: write('error'),
		fatal: write('fatal'),
	};
};

// Copied from @navikt/pino-logger to avoid one more peer-dep
const pinoLogger = (level: string, destination?: pino.DestinationStream): Logger =>
	pino(
		{
			messageKey: 'message',
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
			level,
			// No pid and hostname: one process per pod, and Nais labels each line with the pod already
			base: null,
			mixin: traceIds,
			serializers: { err: serializeError },
			hooks: {
				logMethod(args, method) {
					method.call(this, ...toPinoArgs(args));
				},
			},
		},
		destination
	);

const level = process.env.LOG_LEVEL || 'info';

// JSON in a production build and in any pod on Nais, which always sets NAIS_CLUSTER_NAME. Pretty otherwise.
// NODE_ENV is first so a bundler that sets it can drop pino-pretty
const destination = async () =>
	process.env.NODE_ENV === 'production' || process.env.NAIS_CLUSTER_NAME ? undefined : prettyStream();

/**
 * The logger, called like `console`: `logger.error('Search failed', { status: 500 }, err)`.
 *
 * @see {@link Logger} for how a call becomes a line
 */
// Vitest sets VITEST in its workers
export const logger: Logger = process.env.VITEST ? consoleLogger(level) : pinoLogger(level, await destination());
