/**
 * wiki-lint — structural health checks for the agent-wiki/ directory.
 *
 * Two modes:
 *   tsx scripts/wiki-lint.ts          — fast checks (broken links, footer format)
 *   tsx scripts/wiki-lint.ts --full   — all checks (adds orphans, staleness, status rotation)
 *
 * Fast checks run in preflight and block commits.
 * Full checks run in CI and block deploys.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';

const WIKI_DIR = join(process.cwd(), 'agent-wiki');
const EXCLUDE = new Set(['index.md', 'log.md', 'README.md']);

export interface Finding {
  page: string;
  message: string;
}

export interface WikiLintOpts {
  /** Run full checks (orphans, staleness, status rotation). */
  full?: boolean;
  /** Override wiki directory for testing. */
  wikiDir?: string;
}

export function runWikiLint(opts: WikiLintOpts = {}): Finding[] {
  const wikiDir = opts.wikiDir ?? WIKI_DIR;
  const findings: Finding[] = [];
  const add = (page: string, message: string) => findings.push({ page, message });

  const pages = getAllWikiPages(wikiDir);

  // --- Fast checks (always run) ---

  // 1. Broken internal markdown links
  for (const page of pages) {
    let content = readFileSync(page, 'utf-8');
    // Strip inline code (backtick-delimited) so `grep '](.*\.md)'`
    // doesn't false-positive as a broken link.
    content = content.replace(/`[^`]*`/g, '');
    const links = [...content.matchAll(/\]\(([^)]+\.md)\)/g)];
    for (const match of links) {
      const target = match[1]!;
      const pageDir = dirname(page);
      const resolved = join(pageDir, target);
      if (!existsSync(resolved)) {
        add(relative(wikiDir, page), `broken link: ${target}`);
      }
    }
  }

  // 2. Footer format — every page must have Status and Last updated
  for (const page of pages) {
    const content = readFileSync(page, 'utf-8');
    if (!content.includes('> **Status:**')) {
      add(relative(wikiDir, page), 'missing Status footer');
    }
    if (!content.includes('> **Last updated:**')) {
      add(relative(wikiDir, page), 'missing Last updated footer');
    }
  }

  // --- Full checks ---

  if (opts.full) {
    const pageNames = new Set(pages.map((p) => basename(p)));

    // 3. Orphan detection — pages with no inbound links from other wiki pages
    const inboundMap = new Map<string, string[]>();
    for (const p of pageNames) inboundMap.set(p, []);

    // Scan all pages for links (including index.md, which is excluded
    // from the orphan check itself but IS a valid source of inbound links).
    const allPages = [...pages];
    const indexPath = join(wikiDir, 'index.md');
    if (existsSync(indexPath)) {
      allPages.push(indexPath);
    }

    for (const page of allPages) {
      let content = readFileSync(page, 'utf-8');
      content = content.replace(/`[^`]*`/g, '');
      const links = [...content.matchAll(/\]\(([^)]+\.md)\)/g)];
      for (const match of links) {
        const target = basename(match[1]!);
        if (inboundMap.has(target)) {
          inboundMap.get(target)!.push(relative(wikiDir, page));
        }
      }
    }

    for (const [page, inbounds] of inboundMap) {
      if (inbounds.length === 0 && !EXCLUDE.has(page)) {
        add(page, 'orphan: no inbound links from other wiki pages');
      }
    }

    // 4. Stale pages — untouched for 90+ days.
    //
    // Staleness here is a proxy for "the code moved on and this page did not", so it only
    // means anything for pages that DESCRIBE code. `discipline/` holds process documents —
    // how to think, when to stop, how to maintain this wiki — with no code to drift from, so
    // an old mtime there is just an old mtime. Flagging them trained the reader to skim past
    // the whole staleness section, which is where the one page that WAS wrong hid: an audit
    // found `runtime-selection.md` still describing an agent-home design two releases dead,
    // sitting among five false positives.
    //
    // Touching a file to silence a linter is the failure mode this exemption avoids: it
    // resets the signal without improving the page.
    const now = Date.now();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    const describesCode = (page: string): boolean => !relative(wikiDir, page).startsWith('discipline/');

    for (const page of pages) {
      if (!describesCode(page)) { continue; }
      const mtime = statSync(page).mtimeMs;
      if (now - mtime > ninetyDays) {
        const days = Math.round((now - mtime) / (24 * 60 * 60 * 1000));
        add(relative(wikiDir, page), `stale: untouched for ${days} days`);
      }
    }

    // 5. Status rotation — pages marked "evolving" for 90+ days
    for (const page of pages) {
      if (!describesCode(page)) { continue; }   // same reasoning as the staleness check
      const content = readFileSync(page, 'utf-8');
      if (content.includes('> **Status:** evolving')) {
        const mtime = statSync(page).mtimeMs;
        if (now - mtime > ninetyDays) {
          const days = Math.round((now - mtime) / (24 * 60 * 60 * 1000));
          add(
            relative(wikiDir, page),
            `status is "evolving" but untouched for ${days} days — promote to stable or update`,
          );
        }
      }
    }
  }

  return findings;
}

function getAllWikiPages(wikiDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'archive' && entry.name !== 'bootstrap' && entry.name !== 'scripts') {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !EXCLUDE.has(entry.name)
      ) {
        out.push(full);
      }
    }
  };
  walk(wikiDir);
  return out;
}

// --- CLI entry point ---

if (process.argv[1] && import.meta.url.endsWith(process.argv[1]!.replace(/^.*[\\/]/, ''))) {
  const fullMode = process.argv.includes('--full');
  const findings = runWikiLint({ full: fullMode });

  if (findings.length === 0) {
    console.log(`wiki-lint: clean (${fullMode ? 'full' : 'fast'} mode)`);
    process.exit(0);
  }

  console.error(`wiki-lint: ${findings.length} finding(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.page}: ${f.message}`);
  }
  process.exit(1);
}
