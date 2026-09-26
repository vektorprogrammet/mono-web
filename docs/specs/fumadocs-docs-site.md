# Fumadocs documentation site

Status: frozen for implementation on 2026-09-26 (operator decisions below). Remove this specification when the checks below run in hooks and CI and `AGENTS.md`, the README, and the effect-house overlay describe the new layout.

## Goal

Hand-written documentation has one source: MDX pages in `apps/docs`, written with Fumadocs and mdxcn components, published as a static site.
The root `docs/` folder holds only Markdown generated from those pages, so agents and GitHub readers keep plain `.md` files at the paths they already use.
Vocs is removed.

## Operator decisions (2026-09-26)

- Fumadocs replaces Vocs. The site is a TanStack Start SPA (`create-fumadocs-app` template `tanstack-start-spa`), scaffolded with the official CLI and `--pm bun`, not hand-written from memory.
- Hand-written docs move to `apps/docs`. MDX is the source and uses mdxcn components where a component explains better than prose.
- Root `docs/` contains the Markdown artifacts generated from the Fumadocs pages.
- The Fumadocs agent instructions (`https://fumadocs.dev/llms.txt`; append `.mdx` to any docs URL for Markdown) are the reference. Read the relevant page before using a feature, and never pin an older version.

## Lead decisions (conservative defaults)

- **What moves.** Every hand-written page moves with `git mv`, keeping its content and history; only frontmatter (`title`, `description`) and links change. That is `docs/*.md` and `docs/system-walkthrough.mdx`, `docs/specs/*.md`, and the module guides `packages/domain/src/receipt/README.md` and `packages/domain/src/placements/README.md`. `README.md`, `STATE.md`, `AGENTS.md`/`CLAUDE.md` files, `.agents/skills/**`, and `.github` templates stay where they are: harnesses and GitHub read them in place.
- **Generated paths stay stable.** The generated Markdown keeps today's paths, such as `docs/system.md`, `docs/specs/<name>.md`, and `packages/domain/src/receipt/README.md`. Existing links from `AGENTS.md`, `STATE.md`, the effect-house overlay, the homelab projects-tier extension, and code comments keep working.
- **Each generated file is marked.** It begins with a do-not-edit marker that names its MDX source. A check fails when a generated file differs from a fresh render (drift), and also when someone edits it by hand. Hooks and CI run that check.
- **Specs.** A spec's source is `apps/docs/content/docs/specs/<name>.mdx`. `docs/specs/<name>.md` is its generated read path. The spec convention in `AGENTS.md` and `tools/conventions/src/check.ts` moves to the source path. A worker bound to a spec edits the source and reads either one.
- **Non-Markdown files leave `docs/`.** The formal models `docs/model/authority.als` and `contexts.cml` move to `model/` at the repository root. The exception registry `docs/effect-exceptions.json` moves to `tools/conventions/effect-exceptions.json`. Update their readers (`tools/scripts/model.ts`, `tools/conventions/src/{layout,exceptions}.ts`) and `tools/conventions/src/layout.ts` together.
- **Generated content from code.** Generators such as the construct catalogue, the module guides' hosted-journeys sections, and the effect-house references write MDX into `apps/docs/content/docs/**`. The site renders it, and it reaches `docs/` through the same Markdown generation. Each generator declares its output path in one constant.
- **mdxcn.** The existing graph components in `apps/docs/components/mdxcn` (with `provenance.json`) move into the Fumadocs app's MDX component map, under their existing license and provenance. New mdxcn components are installed through its registry CLI, never copied by hand.
- **Hosting.** The GitHub Pages workflow `.github/workflows/docs.yml` keeps publishing from `main`, with the new static output directory, and still includes the Placements API reference. No other deployment is created.

## Done when

1. `just docs build` builds the static site from a clean checkout. Every moved page renders, has a `title` and a `description`, and appears in the navigation from `meta.json` in today's section order: Start, the system pages, Operations, Specs, Testing. Links between pages resolve; the build fails on a broken internal link.
2. `just docs generate` writes `docs/**` and the module-guide READMEs. `just docs check` fails on a drift and on a hand edit (negative controls for both), and runs in `just check`, the pre-commit hook, and hosted Checks.
3. `docs/` contains only generated `.md` files. The layout check enforces that.
4. `rg -l vocs` finds nothing outside git history and the changelog. `site.ts`, `sync-pages.ts`, and `vocs.config.ts` are gone.
5. The mdxcn graph components render on the system walkthrough page.
6. The docs workflow publishes the new build to Pages on `main`: the first run after landing succeeds, and the site answers.
7. `just check` and the hosted Checks and Tests workflows pass.

## Non-goals

A new docs domain, provider, or search backend beyond what the template configures. Rewriting page content. Moving `STATE.md`, the `AGENTS.md` files, or skills.
