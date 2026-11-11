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

// Highlights the app's own stack in dev so it's easier to read
const withDimmedDependencies = (key: string, value: unknown) =>
	key === 'stack' && typeof value === 'string'
		? value.replaceAll(/^.*node_modules\/.*$/gm, (frame) => styleText('dim', frame))
		: value;

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
		err: (err) => JSON.stringify(err, withDimmedDependencies, 2),
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
type SpanContext = { traceId: string; spanId: string; traceFlags: number };
type Registry = { context?: { active(): { getValue(key: symbol): { spanContext(): SpanContext } | undefined } } };

// Makes request traces work in Grafana, whenever the Nais agent has a span open
const traceIds = () => {
	const registry = (globalThis as { [REGISTRY]?: Registry })[REGISTRY];
	const span = registry?.context?.active().getValue(SPAN)?.spanContext();
	// All zeros means a span that belongs to no trace
	if (!span || /^0+$/.test(span.traceId) || /^0+$/.test(span.spanId)) return {};
	return { trace_id: span.traceId, span_id: span.spanId, trace_flags: `0${span.traceFlags.toString(16)}` };
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
	process.env.NODE_ENV === 'production' ? undefined : await prettyStream()
);
