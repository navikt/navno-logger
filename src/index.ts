import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import pino from 'pino';
import type { PrettyOptions } from 'pino-pretty';

type Log = (...args: unknown[]) => void;
export type Logger = Record<'debug' | 'info' | 'warn' | 'error', Log>;

// Make stacks easier to read:
// - Node's own frames left out
// - paths relative to where the server runs
const cleanStack = (stack = '') => {
	const here = `${process.cwd()}/`;
	return stack
		.replaceAll(pathToFileURL(here).href, '')
		.replaceAll(here, '')
		.split('\n')
		.filter((line) => !/^\s+at .*\bnode:[\w/-]+:\d+:\d+\)?$/.test(line))
		.join('\n');
};

const serializeError = (err: unknown) => {
	const serialized = pino.stdSerializers.err(err as Error);
	return serialized?.stack ? { ...serialized, stack: cleanStack(serialized.stack) } : serialized;
};

// Make pino more ergonomic by supporting `console.log` style args
export const toPinoArgs = (args: unknown[]): [Record<string, unknown>, string] => {
	const fields: Record<string, unknown> = {};
	const text: unknown[] = [];
	for (const arg of args) {
		if (arg instanceof Error) Object.assign(fields, { err: arg, stack: serializeError(arg).stack });
		else if (typeof arg === 'object' && arg !== null) Object.assign(fields, arg);
		else text.push(arg);
	}
	return [fields, text.join(' ')];
};

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
	ignore: 'pid,hostname,stack',
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
		debug: 'blue',
		info: 'green',
		warn: 'yellow',
		error: 'red',
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

// Fixes OTel in Hono so span route-names work.
// - example: app.use(async (c, next) => { await next(); traceRoute(routePath(c)); });
export const traceRoute = (route: string) => {
	const request = fromAgent(REQUEST) as { route?: string } | undefined;
	if (request) request.route = route;
};

// Copied from @navikt/pino-logger to avoid one more peer-dep
export const logger: Logger = pino(
	{
		messageKey: 'message',
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: { level: (label) => ({ level: label }) },
		level: process.env.LOG_LEVEL || 'info',
		mixin: traceIds,
		serializers: { err: serializeError },
		hooks: {
			logMethod(args, method) {
				method.call(this, ...toPinoArgs(args));
			},
		},
	},
	// JSON in a production build and in any pod on Nais, which always sets NAIS_CLUSTER_NAME. Pretty otherwise.
	// NODE_ENV is first so a bundler that sets it can drop pino-pretty
	process.env.NODE_ENV === 'production' || process.env.NAIS_CLUSTER_NAME ? undefined : await prettyStream()
);
