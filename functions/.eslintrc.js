module.exports = {
	root: true,
	env: {
		es6: true,
		node: true,
	},
	extends: [
		"eslint:recommended",
		"plugin:import/errors",
		"plugin:import/warnings",
		"plugin:import/typescript",
		"google",
		"plugin:@typescript-eslint/recommended",
	],
	parser: "@typescript-eslint/parser",
	parserOptions: {
		project: ["tsconfig.json", "tsconfig.dev.json"],
		sourceType: "module",
	},
	ignorePatterns: [
		"/lib/**/*", // Ignore built files.
		"/generated/**/*", // Ignore generated files.
	],
	plugins: [
		"@typescript-eslint",
		"import",
	],
	rules: {
		"quotes": ["error", "double"],
		"import/no-unresolved": 0,
		"indent": ["error", "tab", {"SwitchCase": 1}],
		"no-tabs": "off",
		"operator-linebreak": "off",
		"max-len": "off",
		"require-jsdoc": "off",
		"no-unused-vars": "off",
		"@typescript-eslint/no-unused-vars": ["warn", {"argsIgnorePattern": "^_", "varsIgnorePattern": "^_"}],
	},
};
