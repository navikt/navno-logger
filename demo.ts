// What the logger prints in development: `pnpm dev`. It runs again when this file or src/index.ts is saved,
// so it's also the place to try a change to the pino-pretty options
import pino from 'pino';
import { logger } from './src/index.ts';

logger.debug('Cache hit', { key: 'offices', ageSeconds: 42 });

logger.info('Listening on port', 3001);
logger.info('Loaded offices', { count: 312, seconds: 1.4 });
logger.info('Loaded config', {
	search: { url: 'http://navno-search-api.navno/content/search', timeoutMs: 5000 },
	facets: ['privatperson', 'arbeidsgiver'],
});

logger.warn('Invalid search-url term');
logger.warn('No office found for postnr', { postnr: ['0001', '9999'] });

logger.error('Search failed', { status: 500, facet: 'privatperson', page: 0 });
logger.info('Request handled', { path: '/', status: 200, ms: 12 });
logger.info('Request handled', { path: '/kontakt', status: 200, ms: 8 });
logger.debug('Cache hit', { key: 'offices', ageSeconds: 43 });

logger.error(
	'Failed to fetch search URL',
	new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') })
);
logger.info('Request handled', { path: '/sok?ord=skatt', status: 200, ms: 87 });
logger.info('Loaded offices', { count: 312, seconds: 0.9 });
logger.warn('No office found for postnr', { postnr: ['0002'] });
logger.info('Request handled', { path: '/', status: 200, ms: 9 });

logger.error(
	'Unhandled error',
	{ path: '/sok' },
	new TypeError("Cannot read properties of undefined (reading 'hits')")
);

logger.info('Request handled', { path: '/kontakt', status: 200, ms: 7 });
logger.debug('Cache hit', { key: 'offices', ageSeconds: 44 });

// An error thrown inside a dependency, for what the logger does to a stack: Node's own frames are left out,
// the paths are relative, and the dependency's frames are dimmed
const startWithBadLevel = () => pino({ level: 'loud' });
try {
	startWithBadLevel();
} catch (err) {
	logger.error('Failed to start', err);
}
