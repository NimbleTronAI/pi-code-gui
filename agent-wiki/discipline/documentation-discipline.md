# Documentation Discipline

> **Status:** evolving

> CHANGELOG.md is for **users of the extension**, not a work log. Set by the founder on
> 2026-09-20 and sharpened on 2026-09-22.

## The rule

- **Only user-visible change belongs in CHANGELOG.md.** CI plumbing, release-workflow fixes, repo
  hygiene (`.gitignore`, `.DS_Store`), test refactors and internal guards are omitted entirely.
  They live in commit messages, where they are already thorough.
- **One or two sentences per bullet.** What changed and what the user sees. No why-this-design
  reasoning, no worked examples, no price tables, no internal function or file names.
- **Roughly 5 bullets / ~1,200 characters per release** is the target shape.
- Revise only the release being prepared. Earlier entries are verbose; that is not to be "fixed".
- **README is out of scope.** Leave it alone unless asked — asked and declined, 2026-09-22.

## The failure mode is regrowth, not length

This rule exists because of how it was broken, twice in one session:

1. A 6-bullet, ~1,900-character 0.2.4 entry was called "WAYYYY too wordy", with "items that is
   irrelevant to users". It was trimmed to 4 bullets.
2. Then, while fixing a string of bugs in that same session, a bullet was appended per fix until
   the entry was back to **8 bullets and ~3,000 characters** — and the founder said so again.

Each new bullet looked justified on its own. That is the trap: nobody writes a bloated changelog
in one go, it accretes one defensible line at a time.

## How to apply it

Before finishing **any** turn that touched CHANGELOG.md, re-read the entry *whole* and cut back:

- Strike every bullet a user could not observe from using the extension.
- Fold related bullets together. A pin bump and the install guard that protects it are **one**
  story, not two.
- Compress what survives to its outcome.
- Present a rewrite for approval before committing it.

## Related

- [Agent Coordination](agent-coordination.md) — §24's proven-vs-deferred reporting
- [Strong Opinions, Loosely Held](strong-opinions-loosely-held.md) — thoroughness is right in code
  comments and commit messages, and wrong here

> **Last updated:** 2026-10-06 — moved into the repo from an assistant-private memory file, which AGENTS.md §"Storage rules" rule 4 forbids
