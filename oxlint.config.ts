import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: ['typescript', 'unicorn', 'oxc', 'promise'],
	categories: { correctness: 'error', suspicious: 'error', perf: 'error' },
	options: { reportUnusedDisableDirectives: 'warn', typeAware: true },
	rules: {
		'no-console': 'error',
		'typescript/no-explicit-any': 'error',
		// It would flag every deliberate cast, as in navno-search-frontend
		'typescript/no-unsafe-type-assertion': 'off',
	},
	ignorePatterns: ['dist'],
});
