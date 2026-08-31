# Design spec 0079 - generated API and code reference

## Metadata

| Field                         | Value                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| Status                        | Frozen before implementation                                            |
| Source repository             | `/tmp/mono-web-final-integration`                                       |
| Source branch                 | `integration/0062-final`                                                |
| Source commit                 | `c315db3b5809caffb16e149bd33f0a07b60948f6`                              |
| Worktree                      | `/tmp/mono-web-generated-reference`                                     |
| Branch                        | `feat/0079-generated-api-reference`                                     |
| Vocs authority                | Official Vocs 2.8.5 OpenAPI documentation and installed package source  |
| Docgen authority              | Official `@effect/docgen` 4.0.0-rc.112 documentation and package source |
| Effect application version    | `effect@4.0.0-rc.109`                                                   |
| Public native operation total | 47                                                                      |
| OpenAPI exclusions            | Better Auth `/api/auth/*` and the internal receipt evidence route       |

## Goal

Add generated API and code reference pages to the Vektorprogrammet documentation site.
The generated pages belong to the Reference section of the Diataxis structure.
The current human-first `Routes & API` page remains the route-family overview.

The API reference comes directly from `packages/http-api/openapi.json` through the native Vocs OpenAPI integration.
The code reference comes from public source comments through `@effect/docgen`.
No generated page becomes a second source of API or code truth.

## Canonical sources

| Reference          | Canonical source                                                                      | Generated derivative                             |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Native HTTP API    | `NativeApi` through `packages/http-api/openapi.json`                                  | Vocs OpenAPI pages under `/reference/native-api` |
| Domain code        | Selected public exports and comments in `packages/domain/src`                         | Markdown under `/reference/code/domain`          |
| SDK code           | The default and Effect entrypoints, public schemas, public errors, and their comments | Markdown under `/reference/code/sdk`             |
| HTTP contract code | Public exports and comments in `packages/http-api/src`                                | Markdown under `/reference/code/http-api`        |

`packages/http-api/openapi.json` remains a deterministic derivative of `NativeApi`.
The native `generate:check` command must pass before Vocs builds the reference.
The docs generator must never copy route tables from the OpenAPI file into Markdown.

Source comments are the prose root for the code reference.
Generated Markdown is checked in only as a deterministic derivative.
A maintainer must edit the TypeScript comment, not the generated page.

## API reference scope

The OpenAPI document contains 47 public operations.
The generated landing page must state this exact scope.
It must link back to the human `Routes & API` overview.
The human overview must link to the generated operation reference.

Better Auth owns `/api/auth/*` outside `NativeApi`.
The internal receipt evidence operation is not in the public OpenAPI document.
The docs build must reject either route if it appears in the public document.

The API reference does not state legacy and native capability parity.
Spec 0078 owns capability comparison.
This work does not add a comparator, a copied route list, or a placeholder comparison page.

## Information architecture

Keep these journeys separate:

1. `/reference/routes-and-api` explains route families, owners, and transport boundaries.
2. `/reference/native-api` lists the 47 generated native operations.
3. `/reference/code` explains the generated code-reference scope and package selection.
4. Package and module pages under `/reference/code` document public TypeScript exports.

The top navigation keeps the human `Routes & API` link.
The Reference sidebar adds clear entries for the native API and code reference.
The isolated OpenAPI sidebar includes a link back to the human overview.

Vocs search must index the OpenAPI pages and generated Markdown pages.
Generated pages must not set `search: false`.
A local browser check must find one generated public symbol when local Vocs search supports the built site.

## Vocs OpenAPI integration

Use the official `openapi` site configuration from Vocs 2.8.5.
The configuration uses this source and mount:

```ts
{
  spec: "../../packages/http-api/openapi.json",
  path: "/reference/native-api",
}
```

Vocs generates one page for each OpenAPI tag.
Each operation appears as an anchored section on its tag page.
The generated sidebar links to each operation.
The Vocs build must fail for an unreadable or invalid OpenAPI source.

A generated landing page can use `OpenApi.Endpoints` for the configured mount.
It must identify the canonical JSON file, package version, generator command, and source repository.
It must not repeat method and path data in hand-authored Markdown.

## Code-reference selection

The generator processes only the three selected libraries.
It excludes tests, fixtures, proof programs, runtime entrypoints, persistence adapters, workers, and private implementation modules.

The domain selection includes portable schemas, errors, authority rules, service contracts, and total domain programs.
It excludes PostgreSQL, D1, file-store, worker, outbox, proof, and disposable migration implementations.

The SDK selection includes the Promise entrypoint, the Effect entrypoint, public errors, and public schema modules.
It excludes transport adapters, Promise runtime adapters, tests, and private domain-construction modules.

The HTTP API selection includes all files exported by `packages/http-api/src/index.ts`.
These files contain the dependency-light contract and exclude backend handlers.

Selection policy is generator configuration, not a copied symbol list.
The generator derives symbols and signatures from the selected TypeScript files.
A new selected export appears only after its source comment and generated output pass the gates.

Improve source comments when a public page lacks purpose, boundary, or usage information.
Comments explain consumer-facing meaning.
They do not describe local control flow, private helpers, or implementation trivia.

## Generated Markdown contract

`@effect/docgen` produces Markdown from the selected TypeScript files.
A deterministic adapter converts that Markdown for Vocs without changing symbol prose or signatures.
The adapter can replace incompatible frontmatter and correct nested source links.

Each generated page contains:

- a generated-file warning
- the package name and package version
- the source TypeScript path
- the `@effect/docgen` version
- a repository source link
- the source-derived export documentation

The generator owns one obvious directory under `apps/docs/src/pages/reference/code`.
It replaces only that directory.
It never removes human pages or unrelated generated files.

The generated pages must pass the normal MDX formatter, type, lint, and build checks.
The implementation must correct generated MDX problems in the adapter or source comments.
It must not disable formatting, search, dead-link, or type checks.

## Commands and drift gates

The docs package exposes these commands:

- `generate` writes every docs derivative.
- `generate:check` generates candidates and compares exact bytes without changing tracked files.
- `build` runs the native OpenAPI freshness check, the docs drift check, and the Vocs build.

The repository exposes `docs:generate` and `docs:generate:check`.
The root build runs the docs drift gate.
The root format command regenerates derivatives before formatting them.
The root format check rejects stale or unformatted derivatives.

Generation must remove stale files only inside the owned code-reference directory.
Check mode must reject missing, changed, and extra generated files.
Two consecutive generation runs must produce identical bytes.

The OpenAPI validation gate asserts these facts:

- the document uses OpenAPI 3.1
- it contains exactly 47 HTTP operations
- every operation ID is unique
- no `/api/auth/*` path is present
- no internal evidence path is present

These checks describe public documentation scope.
They do not claim legacy parity.

## Source links and versioning

Use `https://github.com/vektorprogrammet/mono-web` as the repository source.
Generated code pages link to their exact repository-relative source file.
The page records the selected package version from its `package.json`.
The page records the exact docgen version from the installed package.

The generated API landing page records the HTTP API package version.
It identifies `packages/http-api/openapi.json` and `generate:check` as provenance.
Operation descriptions and schemas continue to come from the OpenAPI document.

## Verification

Run these focused checks before the repository gates:

1. Run `packages/http-api` `generate:check`.
2. Generate docs twice and compare all owned generated bytes.
3. Run the docs drift check.
4. Run docs type, lint, format, and build checks.

Then run these root commands in order:

1. `bun run format:check`
2. `bun run check-types`
3. `bun run lint`
4. `bun run build`
5. `bun run test`

Serve the built docs or run the docs development server.
Use a browser to open the API landing page, one operation page, and one code-reference page.
Each page must return 200 and show generated content.
The browser must report no console, page, or request errors.

Use local state only.
Do not use a provider, deploy target, push, shared database, or production resource.

## Falsifiers

This implementation fails the spec if any of these statements is true:

- the API reference copies routes into Markdown
- the docs build accepts a stale OpenAPI artifact
- Better Auth or the internal evidence route appears in the public reference
- a page claims capability parity
- generated code pages include app, persistence, worker, proof, or private implementation modules
- generated Markdown becomes the comment source
- a generator removes a human page or unrelated generated file
- check mode accepts changed, missing, or extra generated files
- generated pages are outside the Reference section
- search excludes the generated pages
- formatting or dead-link checks are disabled
- a generated page lacks source, package version, or generator provenance

## Acceptance

1. This frozen spec is committed before implementation.
2. Vocs mounts the canonical 47-operation OpenAPI document at `/reference/native-api`.
3. The human route overview remains and links to the generated operations.
4. `@effect/docgen` generates useful reference pages for the selected public libraries.
5. Source comments, not generated Markdown, own public code prose.
6. Generation and check commands are deterministic and part of root gates.
7. The docs site builds, indexes generated content, and passes browser checks.
8. All requested sequential repository gates pass.
9. The feature branch contains coherent pathspec commits and ends with a clean worktree.
