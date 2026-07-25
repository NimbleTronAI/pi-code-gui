import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Webview bundler — bundles media/entry.js (which imports core/tools/app
 * in the correct order) into a single IIFE for the VS Code webview.
 * Source maps enabled in dev for debugging.
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[webview-watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        const file = location?.file ?? "esbuild.webview.js";
        const line = location?.line ?? 1;
        const column = location?.column ?? 1;
        console.error(`[webview-esbuild-error] ${file}:${line}:${column}: ${text}`);
      });
      console.log("[webview-watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["./media/entry.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: "media/bundle.js",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    logLevel: "info",
    // marked.min.js uses a UMD pattern that safely falls back to
    // window.marked in the browser.  Suppress the harmless CJS warning.
    logOverride: {
      "commonjs-variable-in-esm": "silent",
    },
    plugins: [esbuildProblemMatcherPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

await main().catch((e) => {
  console.error(e);
  process.exit(1);
});
