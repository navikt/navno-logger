// The same scenarios as demo.ts, written the way plain pino wants them: `(object, message)`, and errors under `err`.
// `pnpm dev:pino` prints the raw JSON, `pnpm dev:pretty` pipes it through pino-pretty with its defaults
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

logger.debug({ key: 'offices', ageSeconds: 42 }, 'Cache hit');

logger.info({ port: 3001 }, 'Listening on port');
logger.info({ count: 312, seconds: 1.4 }, 'Loaded offices');
logger.info(
	{
		search: { url: 'http://navno-search-api.navno/content/search', timeoutMs: 5000 },
		facets: ['privatperson', 'arbeidsgiver'],
	},
	'Loaded config'
);

logger.warn('Invalid search-url term');
logger.warn({ postnr: ['0001', '9999'] }, 'No office found for postnr');

logger.error({ status: 500, facet: 'privatperson', page: 0 }, 'Search failed');
logger.error(
	{ err: new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }) },
	'Failed to fetch search URL'
);
logger.error(
	{ path: '/sok', err: new TypeError("Cannot read properties of undefined (reading 'hits')") },
	'Unhandled error'
);

// An error thrown inside a dependency
const startWithBadLevel = () => pino({ level: 'loud' });
try {
	startWithBadLevel();
} catch (err) {
	logger.error({ err }, 'Failed to start');
}
