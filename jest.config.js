/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
	// The demo vault symlinks the repo root back into itself as the plugin folder.
	testPathIgnorePatterns: ['/node_modules/', '<rootDir>/demo-vault/'],
	modulePathIgnorePatterns: ['<rootDir>/demo-vault/'],
	// Matched in insertion order, first match wins.
	moduleNameMapper: {
		// The obsidian npm package is types-only; all runtime goes to the mock.
		'^obsidian$': '<rootDir>/test/mocks/obsidian.ts',
		// esbuild-plugin-inline-worker turns these into Worker factories; node has no Worker.
		'zip\\.worker$': '<rootDir>/test/mocks/zipWorker.ts',
		'validation\\.worker$': '<rootDir>/test/mocks/unavailableWorker.ts',
	},
	transform: {
		'^.+\\.ts$': [
			'ts-jest',
			{
				// Type checking is tsc's job (`npm run tsc`), not jest's.
				diagnostics: false,
				tsconfig: {
					module: 'commonjs',
					target: 'ES2018',
					lib: ['ES2018', 'DOM'],
					esModuleInterop: true,
				},
			},
		],
	},
	setupFiles: ['<rootDir>/test/setup/polyfills.ts'],
	setupFilesAfterEnv: ['<rootDir>/test/setup/perTest.ts'],
};
