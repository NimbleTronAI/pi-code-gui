import typescriptEslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "out/**", ".pi/**"] },
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
        // `_e` marks a deliberately-unused catch binding. The no-empty rule still bans a silent
        // catch, so this only allows "handled, but the error object isn't needed".
        caughtErrorsIgnorePattern: "^_",
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

  // The webview is compiled by its own project (tsconfig.json excludes src/webview), so typed
  // linting has to be pointed at it explicitly — otherwise every file is a "not found by the
  // project service" parse error. This block is what brought the 4,300-line webview under the
  // same rules as the rest of src/, having been `ignores`d entirely.
  {
    files: ["src/webview/**/*.ts"],
    languageOptions: {
      parser: typescriptEslint.parser,
      parserOptions: {
        // projectService is inherited from the block above and takes precedence over `project`,
        // so it must be switched off here for the webview tsconfig to be used.
        projectService: false,
        project: ["./tsconfig.webview.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // No rule overrides. src/webview used to downgrade no-explicit-any and
    // explicit-function-return-type to warnings — 125 `any`s and 82 missing return types — with
    // the `lint` script capping the count so it could only go down. Both are now at zero, so the
    // webview inherits the same ERROR severity as the rest of src/ and the cap is gone: there is
    // no budget left to spend. A new `any` here fails the build. If one is ever genuinely
    // unavoidable, it needs an eslint-disable line stating why, which is reviewable in a way that
    // a number never was.
  },
];
