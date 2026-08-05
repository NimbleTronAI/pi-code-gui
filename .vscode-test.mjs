import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// Only real VS Code integration tests (Mocha, needs a display). Deliberately NOT
	// 'out/test/**' — that glob swept up the node:test suite, which Mocha loads but cannot
	// execute, so the run reported success while executing none of it.
	files: 'out/test/vscode/**/*.test.js',
});
