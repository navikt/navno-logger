// How a call like console.log becomes what pino takes: an object of fields and a message.
// Kept apart from index.ts so the tests can reach it without it being part of the package.
import { pathToFileURL } from 'node:url';
import { format, inspect } from 'node:util';
import pino from 'pino';

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

export const serializeError = (err: unknown) => {
	const serialized = pino.stdSerializers.err(err as Error);
	return serialized?.stack ? { ...serialized, stack: cleanStack(serialized.stack) } : serialized;
};

// Keys pino writes itself, and where the error goes. A field of the same name would be written a second time,
// as in {"level":"info",…,"level":"fatal"}, and Loki keeps the last one. Such a field gets a _ in front instead.
const RESERVED = new Set(['level', 'time', 'message', 'err', 'stack']);

// Objects written as {…}: their keys become fields. Arrays, Dates, URLs, Maps and class instances go in the
// message instead, the way console prints them, as their keys are not what one means to log
const isPlainObject = (arg: unknown): arg is Record<string, unknown> => {
	if (typeof arg !== 'object' || arg === null) return false;
	const prototype = Object.getPrototypeOf(arg);
	return prototype === Object.prototype || prototype === null;
};

// How many arguments a format string takes: one for each %s, %d, %o, … (%% is a plain %)
const placeholders = (text: string) => text.match(/%[sdifjoOc%]/g)?.filter((match) => match !== '%%').length ?? 0;

// Make pino more ergonomic by supporting `console.log` style args:
// - the first piece of text is a format string, as for console and pino: ('Listening on %s:%d', host, port)
// - the rest of the text, numbers, undefined, … are joined with spaces, printed as console would
// - the keys of plain objects become fields
// - the first Error goes under `err` and `stack`, also when given pino's way: ({ err }, 'Search failed')
// - another Error goes in the message as "Name: message"
export const toPinoArgs = (args: readonly unknown[]): [Record<string, unknown>, string] => {
	const fields: Record<string, unknown> = {};
	const text: string[] = [];
	let err: Error | undefined;
	const addError = (error: Error) => {
		if (err) text.push(String(error));
		else err = error;
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg instanceof Error) addError(arg);
		else if (isPlainObject(arg)) {
			for (const [key, value] of Object.entries(arg)) {
				if (key === 'err' && value instanceof Error) addError(value);
				else fields[RESERVED.has(key) ? `_${key}` : key] = value;
			}
		} else if (typeof arg === 'string' && text.length === 0) {
			const count = placeholders(arg);
			text.push(count ? format(arg, ...args.slice(i + 1, i + 1 + count)) : arg);
			i += count;
		} else text.push(typeof arg === 'string' ? arg : inspect(arg, { breakLength: Infinity }));
	}

	if (err) Object.assign(fields, { err, stack: serializeError(err).stack });
	return [fields, text.join(' ')];
};
