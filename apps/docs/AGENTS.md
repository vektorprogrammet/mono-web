[//]: # "guide: generated from content/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/docs

Documentation site: renders the content folders and the code extracts to the static site and to docs/.
Package `@monoweb/docs`.

## Entry points

The package has no `exports`, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Documentation sources

Write repository pages in the root `content/` folder and workspace pages in that workspace’s `content/` folder. Do not author pages in this app or in `docs/`.
`apps/docs` reads these sources and produces the site and generated Markdown read paths. Run `just docs generate` after a page changes, then `just docs check`.
`apps/docs/generated/` is ignored build output for workspace summaries and construct pages; do not commit it.
