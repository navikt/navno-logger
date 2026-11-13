// node:test's test() returns a promise the runner tracks itself
/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { context, type ContextManager, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType, setRPCMetadata } from '@opentelemetry/core';
import { toPinoArgs, traceRoute } from './index.ts';

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
});

// pino writes straight to the file descriptor, so the output is only visible from outside the process
describe('logger', () => {
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
	`;
	const run = (env: Record<string, string>) =>
		execFileSync(process.execPath, ['--input-type=module', '--eval', LOG], {
			env: { PATH: process.env.PATH, ...env },
			encoding: 'utf-8',
		});

	test('writes one JSON line per call in production', () => {
		const [info, error] = run({ NODE_ENV: 'production' })
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

		assert.equal(info.level, 'info');
		assert.equal(info.message, 'Listening on port 3001');
		assert.match(info.time, /^\d{4}-\d{2}-\d{2}T/);

		assert.equal(error.level, 'error');
		assert.equal(error.message, 'Search failed');
		assert.equal(error.status, 500);
		assert.equal(error.err.message, 'socket hang up');
		assert.match(error.stack, /^Error: socket hang up\n {4}at /);
	});

	test('writes JSON in a pod on Nais, whatever NODE_ENV is', () => {
		const pods: Record<string, string>[] = [
			{ NAIS_CLUSTER_NAME: 'prod-gcp' },
			{ NAIS_CLUSTER_NAME: 'dev-gcp', NODE_ENV: 'development' },
		];
		for (const env of pods) {
			const [info] = run(env).split('\n');

			assert.equal(JSON.parse(info).message, 'Listening on port 3001');
		}
	});

	test('adds the trace IDs of the span that is open', () => {
		const [info, , , inRequest] = run({ NODE_ENV: 'production' })
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

		assert.equal(info.trace_id, undefined);
		assert.equal(inRequest.message, 'In a request');
		assert.equal(inRequest.trace_id, '0af7651916cd43dd8448eb211c80319c');
		assert.equal(inRequest.span_id, 'b7ad6b7169203331');
		assert.equal(inRequest.trace_flags, '01');
	});

	test('cleans the stacks in production, and never colours them', () => {
		// With colours forced on, which is what dims a dependency's frames in the readable output
		const output = run({ NODE_ENV: 'production', FORCE_COLOR: '1' });
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

	test('writes readable lines outside production', () => {
		const output = run({ NODE_ENV: 'development' });

		assert.match(output, /^\d{2}:\d{2}:\d{2} INFO: Listening on port 3001$/m);
		// Each field on a line of its own, under the message
		assert.match(output, /^\d{2}:\d{2}:\d{2} ERROR: Search failed\n {4}status: 500$/m);
		assert.match(output, /Error: socket hang up\n\s+at /);
	});

	test('cleans the stacks in the readable lines too', () => {
		const output = run({ NODE_ENV: 'development' });

		assert.ok(!output.includes('(node:events:'), output);
		assert.ok(!output.includes(process.cwd()), output);
		assert.match(output, /^\s+at pino \(node_modules\/.*\/pino\.js:\d+:\d+\)$/m);
	});

	test('dims the frames from dependencies when the output has colours', () => {
		const frames = run({ NODE_ENV: 'development', FORCE_COLOR: '1' })
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

	test('dims the time when the output has colours', () => {
		const [line] = run({ NODE_ENV: 'development', FORCE_COLOR: '1' }).split('\n');

		// \u001B[2m turns dim on and \u001B[22m turns it off
		const start = line.replace(/\d{2}:\d{2}:\d{2}/, 'TIME');
		assert.ok(start.startsWith('\u001B[2mTIME\u001B[22m '), line);
	});

	test("colours the level and the fields' names, and leaves the message in the terminal's own colour", () => {
		const output = run({ NODE_ENV: 'development', FORCE_COLOR: '1' });

		// 32 is green, 31 is red and 36 is cyan
		assert.ok(output.includes('\u001B[32mINFO\u001B[39m'), output);
		assert.ok(output.includes('\u001B[31mERROR\u001B[39m'), output);
		assert.ok(output.includes('\u001B[36mstatus\u001B[39m: 500'), output);
		// \u001B[0m is "no styling", where pino-pretty has cyan
		assert.ok(output.includes('\u001B[0mSearch failed\u001B[0m'), output);
		// 35 is magenta, pino-pretty's own choice for the fields' names
		assert.ok(!output.includes('\u001B[35m'), output);
	});

	test('LOG_LEVEL sets the lowest level written', () => {
		assert.equal(run({ NODE_ENV: 'production', LOG_LEVEL: 'silent' }), '');
	});
});

// With VITEST set the logger calls console instead of pino: consoleLogger in index.ts says why
describe('logger under Vitest', () => {
	// Vitest makes a Console of its own to record what a test logs. Here one takes the place of the global after the
	// logger has loaded, so a logger that kept hold of the console it loaded with would record nothing
	const LOG = `
		const { logger } = await import('./src/index.ts');
		const calls = [];
		const record = (level) => (...args) =>
			calls.push([level, ...args.map((arg) => (arg instanceof Error ? 'Error: ' + arg.message : arg))]);
		globalThis.console = Object.fromEntries(['debug', 'info', 'warn', 'error', 'log'].map((level) => [level, record(level)]));
		logger.debug('Cache miss', { key: 'a' });
		logger.info('Listening on port', 3001);
		logger.warn('Slow answer', { ms: 900 });
		logger.error('Search failed', { status: 500 }, new Error('socket hang up'));
		process.stdout.write(JSON.stringify(calls));
	`;
	const run = (env: Record<string, string>) =>
		JSON.parse(
			execFileSync(process.execPath, ['--input-type=module', '--eval', LOG], {
				env: { PATH: process.env.PATH, VITEST: 'true', ...env },
				encoding: 'utf-8',
				// Keeps what a failing run writes to stderr in the error thrown here, and out of the test output
				stdio: 'pipe',
			})
		);

	test("calls console's method for the level, with the arguments as given", () => {
		assert.deepEqual(run({}), [
			['info', 'Listening on port', 3001],
			['warn', 'Slow answer', { ms: 900 }],
			['error', 'Search failed', { status: 500 }, 'Error: socket hang up'],
		]);
	});

	test('does so in production builds too, since the tests are what runs', () => {
		assert.equal(run({ NODE_ENV: 'production' }).length, 3);
	});

	test('LOG_LEVEL sets the lowest level written', () => {
		assert.deepEqual(
			run({ LOG_LEVEL: 'debug' }).map(([level]: string[]) => level),
			['debug', 'info', 'warn', 'error']
		);
		assert.deepEqual(
			run({ LOG_LEVEL: 'error' }).map(([level]: string[]) => level),
			['error']
		);
		assert.deepEqual(run({ LOG_LEVEL: 'silent' }), []);
	});

	test('a level pino does not know throws, as it does in production', () => {
		assert.throws(() => run({ LOG_LEVEL: 'loud' }), /default level:loud must be included in custom levels/);
	});
});
