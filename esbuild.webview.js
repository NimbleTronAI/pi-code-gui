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
        console.error(`✘ [webview-ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[webview-watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["media/entry.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    outfile: "media/bundle.js",
    minify: production,
    // Inline (not external) so the dev source map lives inside bundle.js as a
    // data URI — no separate bundle.js.map fetch for DevTools to make, which the
    // webview CSP (default-src 'none', no connect-src) would otherwise block.
    sourcemap: production ? false : "inline",
    // Embed original sources in the inline map so DevTools never reaches back
    // out to fetch *.ts (which CSP would block); dev-only, production has no map.
    sourcesContent: !production,
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
