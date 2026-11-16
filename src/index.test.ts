// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { context, type ContextManager, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType, setRPCMetadata } from '@opentelemetry/core';
import { toPinoArgs } from './args.ts';
import { traceRoute } from './index.ts';

describe('traceRoute', () => {
	test('does nothing where no agent is handling a request', () => {
		assert.doesNotThrow(() => traceRoute('/sok/api/search'));
	});

	test("sets the route on what the agent's HTTP instrumentation keeps for the request", () => {
		// That, made with the real packages: a change in where they keep it fails here
		const span = trace.wrapSpanContext({
			traceId: '0af7651916cd43dd8448eb211c80319c',
			spanId: 'b7ad6b7169203331',
			traceFlags: 1,
		});
		const request = setRPCMetadata(ROOT_CONTEXT, { type: RPCType.HTTP, span });
		// A context manager that is always in that request, where the agent's follows the code that runs
		const manager = { active: () => request, disable: () => undefined };
		context.setGlobalContextManager(manager as unknown as ContextManager);

		try {
			traceRoute('/sok/api/search');
			assert.equal(getRPCMetadata(request)?.route, '/sok/api/search');
		} finally {
			context.disable();
		}
	});
});

describe('toPinoArgs', () => {
	const err = new Error('socket hang up');

	test('text, fields and an error become fields and a message', () => {
		const [fields, message] = toPinoArgs(['Search failed', { status: 500 }, err]);
		const stack = fields.stack as string;

		assert.equal(message, 'Search failed');
		assert.equal(fields.status, 500);
		assert.equal(fields.err, err);
		// Cleaned: this file's frame without the path to the repo, and none of the test runner's own frames
		assert.match(stack, /^Error: socket hang up\n {4}at .*\(src\/index\.test\.ts:\d+:\d+\)/);
		assert.ok(!stack.includes('node:'), stack);
	});

	test("the stack has the stacks of the error's causes", () => {
		const [fields] = toPinoArgs([new Error('fetch failed', { cause: new Error('bad port') })]);

		assert.match(fields.stack as string, /^Error: fetch failed\n[^]*\ncaused by: Error: bad port\n {4}at /);
	});

	test("pino's own order gives the same", () => {
		assert.deepEqual(
			toPinoArgs([err, { status: 500 }, 'Search failed']),
			toPinoArgs(['Search failed', { status: 500 }, err])
		);
	});

	test('text parts are joined, as console does', () => {
		assert.deepEqual(toPinoArgs(['Listening on port', 3001]), [{}, 'Listening on port 3001']);
	});

	test('the first text is a format string, as for console and pino', () => {
		assert.deepEqual(toPinoArgs(['Listening on %s:%d', 'localhost', 3001]), [{}, 'Listening on localhost:3001']);
		assert.deepEqual(toPinoArgs(['Got %o', { a: 1 }]), [{}, 'Got { a: 1 }']);
		assert.deepEqual(toPinoArgs([{ status: 500 }, 'Search failed in %s', 'sok']), [
			{ status: 500 },
			'Search failed in sok',
		]);
		// What is left over after the placeholders is logged as usual
		assert.deepEqual(toPinoArgs(['Got %s', 'a', 'b', { status: 500 }]), [{ status: 500 }, 'Got a b']);
	});

	test('only the first text is a format string, and a % on its own is text', () => {
		assert.deepEqual(toPinoArgs(['Done', '%s', 'x']), [{}, 'Done %s x']);
		assert.deepEqual(toPinoArgs(['100% done']), [{}, '100% done']);
		assert.deepEqual(toPinoArgs(['100%% of %s', 'it']), [{}, '100% of it']);
	});

	test('values that are not text are printed as console prints them', () => {
		assert.deepEqual(toPinoArgs(['Got', undefined, null, true, 10n, Symbol('s')]), [
			{},
			'Got undefined null true 10n Symbol(s)',
		]);
	});

	test('arrays, dates, maps and class instances go in the message, on one line', () => {
		class Office {
			postnr = '0001';
		}
		const [fields, message] = toPinoArgs(['Got', ['a', 'b'], new Date(0), new Map([['a', 1]]), new Office()]);

		assert.deepEqual(fields, {});
		assert.equal(message, "Got [ 'a', 'b' ] 1970-01-01T00:00:00.000Z Map(1) { 'a' => 1 } Office { postnr: '0001' }");
	});

	test('objects without a prototype are fields too', () => {
		const headers = Object.assign(Object.create(null), { accept: 'text/html' });

		assert.deepEqual(toPinoArgs(['Request', headers]), [{ accept: 'text/html' }, 'Request']);
	});

	test("fields named like pino's own keys get a _ in front, so the line has each key once", () => {
		const [fields, message] = toPinoArgs([
			'Answer',
			{ message: 'Not found', level: 'fatal', time: 1, err: 'timeout', stack: 'a', status: 404 },
		]);

		assert.equal(message, 'Answer');
		assert.deepEqual(fields, {
			_message: 'Not found',
			_level: 'fatal',
			_time: 1,
			_err: 'timeout',
			_stack: 'a',
			status: 404,
		});
	});

	test("an error given pino's way, under err, is the error", () => {
		const [fields, message] = toPinoArgs([{ err, status: 500 }, 'Search failed']);

		assert.equal(message, 'Search failed');
		assert.equal(fields.err, err);
		assert.equal(fields.status, 500);
		assert.match(fields.stack as string, /^Error: socket hang up\n/);
	});

	test('the first error is the error, and any more go in the message', () => {
		const [fields, message] = toPinoArgs(['Both failed', err, new TypeError('no hits')]);

		assert.equal(fields.err, err);
		assert.equal(message, 'Both failed TypeError: no hits');
	});
});

// Each run is a Node process of its own, which takes about 100 ms. So each env runs once, whichever tests ask for it,
// and the tests that wait on them run side by side
const runs = new Map<string, Promise<string>>();
const runScript = (script: string, env: Record<string, string>) => {
	const key = JSON.stringify([script, env]);
	let output = runs.get(key);
	if (!output) {
		output = promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
			env: { PATH: process.env.PATH, ...env },
			encoding: 'utf-8',
		}).then(({ stdout }) => stdout);
		runs.set(key, output);
	}
	return output;
};

// pino writes straight to the file descriptor, so the output is only visible from outside the process
describe('logger', { concurrency: true }, () => {
	const LOG = `
		import { EventEmitter } from 'node:events';
		import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
		import pino from 'pino';
		import { logger } from './src/index.ts';
		logger.info('Listening on port', 3001);
		// From a listener, so the stack has a frame of Node's own: "at EventEmitter.emit (node:events:…)"
		new EventEmitter()
			.on('fail', () => logger.error('Search failed', { status: 500 }, new Error('socket hang up')))
			.emit('fail');
		// An error thrown inside a dependency
		try {
			pino({ level: 'loud' });
		} catch (err) {
			logger.warn('Bad level', err);
		}
		// From here on a span is open, as the NAIS agent has one during a request
		const span = trace.wrapSpanContext({
			traceId: '0af7651916cd43dd8448eb211c80319c',
			spanId: 'b7ad6b7169203331',
			traceFlags: 1,
		});
		context.setGlobalContextManager({
			active: () => trace.setSpan(ROOT_CONTEXT, span),
			with: (_context, fn, thisArg, ...args) => fn.call(thisArg, ...args),
			bind: (_context, target) => target,
			enable() { return this; },
			disable() { return this; },
		});
		logger.info('In a request');
		logger.trace('Answer from search', { hits: 3 });
		logger.fatal('Could not start', new Error('port in use'));
	`;
	const run = (env: Record<string, string>) => runScript(LOG, env);
	const jsonLines = async (env: Record<string, string> = {}) =>
		(await run({ NODE_ENV: 'production', ...env }))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

	test('writes one JSON line per call in production', async () => {
		const [info, error] = await jsonLines();

		assert.equal(info.level, 'info');
		assert.equal(info.message, 'Listening on port 3001');
		assert.match(info.time, /^\d{4}-\d{2}-\d{2}T/);
		// One process per pod, and Nais labels each line with the pod
		assert.equal(info.pid, undefined);
		assert.equal(info.hostname, undefined);

		assert.equal(error.level, 'error');
		assert.equal(error.message, 'Search failed');
		assert.equal(error.status, 500);
		assert.equal(error.err.message, 'socket hang up');
		assert.match(error.stack, /^Error: socket hang up\n {4}at /);
	});

	test('writes JSON in a pod on Nais, whatever NODE_ENV is', async () => {
		const pods: Record<string, string>[] = [
			{ NAIS_CLUSTER_NAME: 'prod-gcp' },
			{ NAIS_CLUSTER_NAME: 'dev-gcp', NODE_ENV: 'development' },
		];
		for (const output of await Promise.all(pods.map(run))) {
			const [info] = output.split('\n');

			assert.equal(JSON.parse(info).message, 'Listening on port 3001');
		}
	});

	test('adds the trace IDs of the span that is open', async () => {
		const [info, , , inRequest] = await jsonLines();

		assert.equal(info.trace_id, undefined);
		assert.equal(inRequest.message, 'In a request');
		assert.equal(inRequest.trace_id, '0af7651916cd43dd8448eb211c80319c');
		assert.equal(inRequest.span_id, 'b7ad6b7169203331');
		assert.equal(inRequest.trace_flags, '01');
	});

	test('cleans the stacks in production, and never colours them', async () => {
		// With colours forced on, which is what dims a dependency's frames in the readable output
		const output = await run({ NODE_ENV: 'production', FORCE_COLOR: '1' });
		const [, error, warning] = output
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

		for (const stack of [error.stack, error.err.stack, warning.stack, warning.err.stack]) {
			assert.ok(!stack.includes('(node:events:'), stack);
			assert.ok(!stack.includes(process.cwd()), stack);
		}
		assert.match(warning.err.stack, /^\s+at pino \(node_modules\/.*\/pino\.js:\d+:\d+\)$/m);
		// The escape character that starts a colour code, as JSON writes it
		assert.ok(!output.toLowerCase().includes(String.raw`\u001b`), output);
	});

	test('writes readable lines outside production', async () => {
		const output = await run({ NODE_ENV: 'development' });

		assert.match(output, /^\d{2}:\d{2}:\d{2} INFO: Listening on port 3001$/m);
		// Each field on a line of its own, under the message
		assert.match(output, /^\d{2}:\d{2}:\d{2} ERROR: Search failed\n {4}status: 500$/m);
		assert.match(output, /Error: socket hang up\n\s+at /);
	});

	test('cleans the stacks in the readable lines too', async () => {
		const output = await run({ NODE_ENV: 'development' });

		assert.ok(!output.includes('(node:events:'), output);
		assert.ok(!output.includes(process.cwd()), output);
		assert.match(output, /^\s+at pino \(node_modules\/.*\/pino\.js:\d+:\d+\)$/m);
	});

	test('dims the frames from dependencies when the output has colours', async () => {
		const frames = (await run({ NODE_ENV: 'development', FORCE_COLOR: '1' }))
			.split('\n')
			.filter((line) => line.includes(' at '));

		// \u001B[2m turns dim on
		const dimmed = frames.filter((line) => line.trimStart().startsWith('\u001B[2m'));
		assert.ok(dimmed.length > 0, frames.join('\n'));
		assert.ok(
			dimmed.every((line) => line.includes('node_modules/')),
			frames.join('\n')
		);
	});

	test('dims the time when the output has colours', async () => {
		const [line] = (await run({ NODE_ENV: 'development', FORCE_COLOR: '1' })).split('\n');

		// \u001B[2m turns dim on and \u001B[22m turns it off
		const start = line.replace(/\d{2}:\d{2}:\d{2}/, 'TIME');
		assert.ok(start.startsWith('\u001B[2mTIME\u001B[22m '), line);
	});

	test("colours the level and the fields' names, and leaves the message in the terminal's own colour", async () => {
		const output = await run({ NODE_ENV: 'development', FORCE_COLOR: '1' });

		// 32 is green, 31 is red and 36 is cyan
		assert.ok(output.includes('\u001B[32mINFO\u001B[39m'), output);
		assert.ok(output.includes('\u001B[31mERROR\u001B[39m'), output);
		assert.ok(output.includes('\u001B[36mstatus\u001B[39m: 500'), output);
		// \u001B[0m is "no styling", where pino-pretty has cyan
		assert.ok(output.includes('\u001B[0mSearch failed\u001B[0m'), output);
		// 35 is magenta, pino-pretty's own choice for the fields' names
		assert.ok(!output.includes('\u001B[35m'), output);
	});

	test("writes pino's levels that console doesn't have: fatal, and trace when LOG_LEVEL lets it through", async () => {
		const fatal = (await jsonLines()).at(-1);
		assert.equal(fatal.level, 'fatal');
		assert.equal(fatal.message, 'Could not start');
		assert.equal(fatal.err.message, 'port in use');
		assert.ok(!(await jsonLines()).some((line) => line.level === 'trace'));

		const traced = (await jsonLines({ LOG_LEVEL: 'trace' })).find((line) => line.level === 'trace');
		assert.equal(traced.message, 'Answer from search');
		assert.equal(traced.hits, 3);
	});

	test('LOG_LEVEL sets the lowest level written', async () => {
		assert.equal(await run({ NODE_ENV: 'production', LOG_LEVEL: 'silent' }), '');
		assert.deepEqual(
			(await jsonLines({ LOG_LEVEL: 'fatal' })).map((line) => line.level),
			['fatal']
		);
	});

	test('colours fatal and trace like pino-pretty does', async () => {
		const output = await run({ NODE_ENV: 'development', FORCE_COLOR: '1', LOG_LEVEL: 'trace' });

		// 41 is a red background and 90 is grey
		assert.ok(output.includes('\u001B[41mFATAL\u001B[49m'), output);
		assert.ok(output.includes('\u001B[90mTRACE\u001B[39m'), output);
	});
});

// With VITEST set the logger calls console instead of pino: consoleLogger in index.ts says why
describe('logger under Vitest', { concurrency: true }, () => {
	// Vitest makes a Console of its own to record what a test logs. Here one takes the place of the global after the
	// logger has loaded, so a logger that kept hold of the console it loaded with would record nothing
	const LOG = `
		const { logger } = await import('./src/index.ts');
		const calls = [];
		const record = (level) => (...args) =>
			calls.push([level, ...args.map((arg) => (arg instanceof Error ? 'Error: ' + arg.message : arg))]);
		globalThis.console = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'log'].map((level) => [level, record(level)]));
		logger.trace('Answer from search', { hits: 3 });
		logger.debug('Cache miss', { key: 'a' });
		logger.info('Listening on port', 3001);
		logger.warn('Slow answer', { ms: 900 });
		logger.error('Search failed', { status: 500 }, new Error('socket hang up'));
		logger.fatal('Could not start', new Error('port in use'));
		process.stdout.write(JSON.stringify(calls));
	`;
	const run = async (env: Record<string, string>) => JSON.parse(await runScript(LOG, { VITEST: 'true', ...env }));

	test("calls console's method for the level, with the arguments as given", async () => {
		assert.deepEqual(await run({}), [
			['info', 'Listening on port', 3001],
			['warn', 'Slow answer', { ms: 900 }],
			['error', 'Search failed', { status: 500 }, 'Error: socket hang up'],
			['error', 'Could not start', 'Error: port in use'],
		]);
	});

	test("trace and fatal, which console doesn't have as levels, go to console.debug and console.error", async () => {
		assert.deepEqual((await run({ LOG_LEVEL: 'trace' })).slice(0, 2), [
			['debug', 'Answer from search', { hits: 3 }],
			['debug', 'Cache miss', { key: 'a' }],
		]);
	});

	test('does so in production builds too, since the tests are what runs', async () => {
		assert.equal((await run({ NODE_ENV: 'production' })).length, 4);
	});

	test('LOG_LEVEL sets the lowest level written', async () => {
		assert.deepEqual(
			(await run({ LOG_LEVEL: 'debug' })).map(([level]: string[]) => level),
			['debug', 'info', 'warn', 'error', 'error']
		);
		assert.deepEqual(
			(await run({ LOG_LEVEL: 'error' })).map(([, message]: string[]) => message),
			['Search failed', 'Could not start']
		);
		assert.deepEqual(
			(await run({ LOG_LEVEL: 'fatal' })).map(([, message]: string[]) => message),
			['Could not start']
		);
		assert.deepEqual(await run({ LOG_LEVEL: 'silent' }), []);
	});

	test('a level pino does not know throws, as it does in production', async () => {
		await assert.rejects(run({ LOG_LEVEL: 'loud' }), /default level:loud must be included in custom levels/);
	});
});
