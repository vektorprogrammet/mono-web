# Fumadocs documentation site

Status: frozen for implementation on 2026-09-26 (operator decisions below). Remove this specification when the checks below run in hooks and CI and `AGENTS.md`, the README, and the effect-house overlay describe the new layout.

## Goal

Hand-written documentation is written where its scope is: repository-wide pages in the root `content/`, and each app, package, or tool's pages in its own `content/`. `apps/docs` only renders them: it holds the Fumadocs site code and no authored pages. The pages are MDX with mdxcn components, published as one static site.
The root `docs/` folder stops being where docs are written. It holds only generated artifacts of any file type: Markdown rendered from the Fumadocs pages at the paths agents and GitHub readers already use, and outputs of other generators. Every file in it names its generator.
Vocs is removed.

## Operator decisions (2026-09-26)

- Fumadocs replaces Vocs. The site is a TanStack Start SPA (`create-fumadocs-app` template `tanstack-start-spa`), scaffolded with the official CLI and `--pm bun`, not hand-written from memory.
- Hand-written docs are MDX, written in a `content/` folder at the scope they describe: the repository root for repository-wide pages, and the workspace for a workspace's pages. They use mdxcn components where a component explains better than prose. `apps/docs` renders them and holds no content.
- Root `docs/` contains the Markdown artifacts generated from the Fumadocs pages.
- The Fumadocs agent instructions (`https://fumadocs.dev/llms.txt`; append `.mdx` to any docs URL for Markdown) are the reference. Read the relevant page before using a feature, and never pin an older version.

## Lead decisions (conservative defaults)

- **What moves.** Every hand-written page moves with `git mv`, keeping its content and history; only frontmatter (`title`, `description`) and links change. Cross-cutting pages (`docs/*.md`, `docs/system-walkthrough.mdx`, `docs/specs/*.md`) go to `content/<section>/`. A page about one workspace goes to that workspace's `content/`: the guides `packages/domain/src/receipt/README.md` and `packages/domain/src/placements/README.md` become `packages/domain/content/receipt.mdx` and `placements.mdx`. `README.md`, `STATE.md`, `AGENTS.md`/`CLAUDE.md` files, `.agents/skills/**`, and `.github` templates stay where they are: harnesses and GitHub read them in place.
- **Generated paths.** Cross-cutting pages keep today's read paths (`docs/system.md`, `docs/specs/<name>.md`, …), so links from `AGENTS.md`, `STATE.md`, the effect-house overlay, and the homelab projects-tier extension keep working. A workspace's pages are generated to `docs/<apps|packages|tools>/<name>/**.md`. Moved per-workspace pages change path, so the move rewrites every link to them, and the build's link check fails on any stale one.
- **Each generated file is marked.** It begins with a do-not-edit marker that names its MDX source. A check fails when a generated file differs from a fresh render (drift), and also when someone edits it by hand. Hooks and CI run that check.
- **Specs.** A spec's source is `content/specs/<name>.mdx`. `docs/specs/<name>.md` is its generated read path. The spec convention in `AGENTS.md` and `tools/conventions/src/check.ts` moves to the source path. A worker bound to a spec edits the source and reads either one.
- **Where documentation is written** (operator decisions, 2026-09-26). Two kinds of source, one site:
  - **Repository-wide** documentation lives in `content/` at the repository root (operator decision, 2026-09-26), and its folders are the site's sections: `system/`, `architecture/`, `operations/`, `specs/`, `testing/`, `model/`. The formal models `docs/model/authority.als` and `contexts.cml` move to `content/model/`, and the site renders or links them from there.
  - **Each workspace** (every `apps/*`, `packages/*`, and `tools/*` package) may have its own `content/` folder beside its `package.json`. The site scans `apps/*/content/**`, `packages/*/content/**`, and `tools/*/content/**`. Each workspace gets one section, named from its layout description in `tools/conventions/src/layout.ts`; its `content/` folders are its subsections. A workspace without `content/` still gets a section: its generated summary (description, entry points from `exports`, constructs), from the same source as its `AGENTS.md` guide. Generated API references belong to their workspace's section: the Placements TypeDoc reference goes under `packages/domain`.
  - Folder names and `meta.json` give the navigation order; nothing lists pages by hand. Use Fumadocs' support for multiple content sources if its docs confirm it; otherwise generate one content index from the scan. Either way the scan is the only list.
  - `content/` holds only `.mdx`, `.md`, `meta.json`, and assets. The layout check declares `content/` for every workspace and enforces that.
  - The exception registry `docs/effect-exceptions.json` is a tool's input, not documentation, so it moves to `tools/conventions/effect-exceptions.json`.
  - Update the readers (`tools/scripts/model.ts`, `tools/conventions/src/{layout,exceptions}.ts`) in the same commit. A file that a generator writes may stay in `docs/`, whatever its type.
- **Inputs and outputs** (operator decision, 2026-09-26). The documentation has two inputs and one producer:
  - **Inputs:** `content/` folders (hand-written prose, at the root and in each workspace) and `src/` (code: JSDoc and construct contracts, types, the OpenAPI contract, package `exports`, the formal models).
  - **Producer:** `apps/docs` is the only thing that turns inputs into documentation artifacts. It renders `content/` and calls the extractors that read `src/` (the construct and contract reader in `tools/conventions`, the OpenAPI output of `packages/http-api`, the TypeDoc reference). The extractors stay where they are and export their data; `apps/docs` owns the rendering.
  - **Outputs:** the static site for people, and `docs/` for agents and GitHub readers: Markdown at stable paths plus `llms.txt` and `llms-full.txt`.
  - `content/` holds hand-written pages only. No generator writes into `content/`, so a file there is always authored, and a file in `docs/` is always generated. Generated pages such as the construct catalogue and the API references are produced by `apps/docs` straight into the site and `docs/`.
  - Harness instruction files are not documentation artifacts: the generated part of each `AGENTS.md` stays in place. `just guides write` writes it from the same extractor function that produces the workspace summary on the site, so the two cannot disagree.
- **mdxcn.** The existing graph components in `apps/docs/components/mdxcn` (with `provenance.json`) move into the Fumadocs app's MDX component map, under their existing license and provenance. New mdxcn components are installed through its registry CLI, never copied by hand.
- **HTTP API reference.** The Vocs site had an HTTP API page generated from the OpenAPI contract. Keep it: generate it with the Fumadocs OpenAPI integration from the `packages/http-api` OpenAPI output, so the page stays derived from the contract.
- **Start section.** `README.md` and `STATE.md` stay in place. The Start section includes them as they are, and nothing is generated for them.
- **Drafts.** Untested drafts of the link plugin, the generator and the check from the first pass are in `/srv/share/projects/vektorprogrammet/fumadocs-drafts-0926/`. They assume `content/docs/` and a root `model/` folder, so retarget them.
- **Hosting.** The GitHub Pages workflow `.github/workflows/docs.yml` keeps publishing from `main`, with the new static output directory, and still includes the Placements API reference. No other deployment is created.

## Done when

1. `just docs build` builds the static site from a clean checkout. Every moved page renders, has a `title` and a `description`, and appears in the navigation from `meta.json` in today's section order: Start, the system pages, Operations, Specs, Testing. Links between pages resolve; the build fails on a broken internal link.
2. `just docs generate` writes `docs/**`: cross-cutting pages at their current paths, and each workspace under `docs/<apps|packages|tools>/<name>/`. `just docs check` fails on a drift and on a hand edit (negative controls for both), and runs in `just check`, the pre-commit hook, and hosted Checks.
2a. Adding `content/intro.mdx` to a workspace that had none makes that page appear in the workspace's section and in `docs/`, with no configuration change (test). Every workspace appears in the navigation.
3. Every file in `docs/` is the output of a registered generator, and a hand-authored file there fails the layout check (negative control). The generators are listed in one place, with the output path of each.
3a. No file under any `content/` folder is written by a generator. A generator that writes there fails the layout check (negative control).
4. `rg -l vocs` finds nothing outside git history and the changelog. `site.ts`, `sync-pages.ts`, and `vocs.config.ts` are gone.
5. The mdxcn graph components render on the system walkthrough page.
6. The docs workflow publishes the new build to Pages on `main`: the first run after landing succeeds, and the site answers.
7. `just check` and the hosted Checks and Tests workflows pass.

## Documentation that must change

`docs/` stops being where docs are written, so every instruction that tells a writer to edit a file there changes to the source in the right `content/` folder (the repository root for repository-wide pages, the workspace for its own), and says that `docs/` is a generated read path:

- `AGENTS.md` (Authority, the spec convention, the documentation rules), `README.md`, `apps/docs/AGENTS.md`, `tools/conventions/AGENTS.md`, `STATE.md` (Lead handoff), and the effect-house overlay.
- Generated guides and the layout description in `tools/conventions/src/layout.ts`.
- Outside this repository: the cross-project rule "specs live in `docs/specs/`" in `/srv/share/projects/homelab/docs/PROJECTS.md` (lines 186-193 and 433). The lead changes it in the homelab repository to say this: a repository that generates its docs keeps the spec source where its docs site says, and still serves the read path `docs/specs/`.

## Non-goals

A new docs domain, provider, or search backend beyond what the template configures. Rewriting page content. Moving `STATE.md`, the `AGENTS.md` files, or skills.
