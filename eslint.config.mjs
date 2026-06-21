import typescriptEslint from "typescript-eslint";

export default [
  { ignores: ["src/webview/**", "dist/**", "out/**", ".pi/**"] },
  {
    files: ["src/**/*.ts"],
    plugins: { "@typescript-eslint": typescriptEslint.plugin },
    languageOptions: {
      parser: typescriptEslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // ── Ban silent failures ─────────────────────────
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        varsIgnorePattern: "^_",
      }],

      // ── Ban type slop ───────────────────────────────
      "@typescript-eslint/no-explicit-any": "error",

      // ── Ban dangling control flow ────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // ── Existing, bumped to error ────────────────────
      curly: "error",
      eqeqeq: "error",
      "no-throw-literal": "error",
      semi: "error",
      "@typescript-eslint/naming-convention": ["error", {
        selector: "import",
        format: ["camelCase", "PascalCase"],
      }],

      // ── Explicit return types ────────────────────────
      "@typescript-eslint/explicit-function-return-type": ["error", {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
      }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
  {
    // Tests use the node:test runner: top-level test() calls intentionally
    // "float", and fixtures use `any` / untyped callbacks. Relax those rules
    // for test files only — production code keeps the strict settings above.
    files: ["src/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
];
