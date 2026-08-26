# Design spec 0062 - native content publication

## Metadata

| Field             | Value                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal              | Replace the Symfony article-admin seam with one native editorial authority and serve published news to the public homepage with zero legacy requests                                                       |
| Status            | Contract remains frozen; implementation is present at integrated branch `f07b86d7babc041ee5f947b41381de094586e9d6`; runtime and acceptance evidence are pending |
| Base              | `13f6952ea7965c26fb40101635f3e5c850f0065e` (`13f6952`)                                                                                                                                                     |
| Depends on        | 0040 logical capability topology, 0045 Effect Model/Service authority (0045.2 Layers), 0054 native Identity sessions, 0055 person-keyed authorization authorities, 0061 native journey/evidence precedents |
| Actors            | Staff editor: active member, active team leader, or active global Organization administrator                                                                                                               |
| Route             | `/dashboard/artikler` (staff), `/nyheter` and `/nyhet/{slug}` (public)                                                                                                                                     |
| Journey authority | `intent://journey:parity:content_publication:v1` and `intent://journey:parity:content_public:v1` from design spec 0024                                                                                     |
| Architecture      | Design spec 0040 assigns `Content` and `ContentManagement` their logical authorities; Database, Organization, and Profile requirements remain explicit until the process composition root                  |
| Operator boundary | No production import, production data change, credential change, deployment, or external effect. Disposable local PostgreSQL and Chromium evidence only                                                    |
| Scope hold        | Identity credentials, sessions, and the Better Auth cutover remain spec 0054's contract; this spec does not touch them                                                                                     |

### Amendment 0062.1 — exact staff working-copy detail

This amendment supersedes only the staff endpoint, SDK, Foldkit selection, and evidence clauses named below. The original workspace observation intentionally excludes `bodyHtml` and `revision`, but an optimistic revision cannot safely start from that summary. A fresh selection therefore reads one authorized working copy instead of inventing revision `0`, reusing stale editor bytes, or widening the workspace response.

The one additional endpoint is `GET /api/admin/content/articles/{articleId}`. It returns exactly `articleId`, `title`, `slug`, `status`, `bodyHtml`, `sticky`, `createdAt`, `updatedAt`, `currentVersionNumber`, `revision`, `departmentIds`, `canRevise`, `canPublish`, and `authorDisplayName`. It never returns `createdByPersonId`. `ContentManagement` resolves current Organization authority inside the same repeatable-read transaction as the article, department, and author projections. Missing articles return 404; known but unauthorized working copies return the existing typed 403 denial. No public endpoint or public shape changes.

The SDK method is `client.admin.content.read(articleId)`. Foldkit issues it when an editable row is selected, accepts the result only under the current request identity and matching article id, and only then exposes body and revision for mutation. `CommandConflict` invalidates the selected revision so a subsequent selection must perform a fresh detail read. Browser evidence must cover a fresh selection, strict detail decoding, absence of the private creator id, a stale-revision conflict, and a successful repeated revision after a new detail read.

## Problem

The staff publication workflow still runs entirely in Symfony. `AppBundle:ArticleAdmin` owns `/kontrollpanel/artikkeladmin` (list), `/opprett` (create), `/rediger/{id}` (edit), `/sticky/{id}`, `/slett/{id}`, and the draft preview at `/kontrollpanel/artikkel/kladd/{slug}`. The mono mirror carries the same controllers and the `App\Content\Api\Resource` write resources, and its ApiPlatform `Article` CRUD rows sit under the accepted `content_publication` intent. The native backend serves none of these paths: `apps/backend/src/router.ts` has no article listener, and `apps/dashboard` has no article route at all, so there is no native place to draft or publish.

The public side is equally dead. Legacy Symfony renders `/nyheter`, `/nyheter/{department}`, and `/nyhet/{slug}` from `AppBundle:Article`, and `HomeController::showAction` feeds the front-page carousel with `findStickyAndLatestArticles()`. The native homepage (`apps/homepage`) renders only `dev-content`: its navigation has no news entry, no route reads articles, and the build-provenance digests cover a site that cannot show one published story.

A mechanical endpoint graft would repeat the mistake 0061 corrected for schools: the wire shape exists, the product journey does not. This contract freezes the whole journey instead: one person-keyed editorial authority, one immutable published-version record, one Foldkit staff workspace, and one server-rendered public read that reaches `https://vektor.phibkro.org` through the same authoritative database.

## Source evidence

This contract uses these sources:

- Legacy `src/AppBundle/Entity/Article.php` (mirrored at `apps/server/src/App/Content/Infrastructure/Entity/Article.php`): columns `id`, `title`, unique `slug`, free-text `article` body, `imageLarge`, `imageSmall`, `created`, `updated`, `sticky`, nullable `published`, ManyToMany `departments` (join table `articles_departments`), ManyToOne `author` (`SET NULL`).
- Legacy `ArticleAdminController`: create sets the author to the signed-in user, generates the slug, uploads small and large images, and persists with `published` chosen by a `Kladd|Publisert` choice; edit re-uploads images and flushes without an ownership check; sticky is an AJAX toggle; delete is a plain POST; the draft preview renders the same show template with an `isDraft` banner.
- Legacy `SlugMaker::setSlugFor`: lowercases, transliterates `æøå` to `ae/o/a`, strips non `[A-Za-z0-9-]`, deduplicates against all existing slugs by appending `-2`, `-3`, …; invoked at creation only, never on edit.
- Legacy `ArticleRepository`: `findAllPublishedArticles` orders by `created DESC`; `findStickyAndLatestArticles` intends sticky-first with a 30-day window but its `orWhere` drops the published constraint — a corrected accident, not a contract; `findAllArticlesByDepartments` includes rows with no departments for every filter.
- Legacy `security.yml`: `^/kontrollpanel` requires `ROLE_TEAM_MEMBER`; only `is_granted_team_leader()` sees the delete button; no article-specific rule elevates create, edit, publish, or sticky.
- Legacy templates: `home/index.html.twig` receives `news` for the carousel; `article/carousel.html.twig` links each slide to `article_show` by slug; `article/show.html.twig` prints author first and last name, `created`, and the raw body through the script/iframe-blacklisting `safe_html` filter; `article/index.html.twig` paginates 10 per page with a department filter.
- Mono parity evidence: `evidence/functional-parity/user-journey-coverage.json` accepts `intent://journey:parity:content_publication:v1` (operator-visible) and `intent://journey:parity:content_public:v1` (user-visible); `api-operations.json` covers the `App\Content\Infrastructure\Entity\Article` ApiPlatform collection and item operations plus the `AdminSocialEvent*`, `AdminChangelog*`, and `AdminStaticContent*` resources under these intents; the six `App\Content\Api\Resource\Admin*Resource` plumbing rows are `accounted` extras with reason `RUNTIME_ONLY_SOURCE` under `framework_runtime_plumbing`, so no unresolved-class debt blocks this journey.
- `apps/backend/src/router.ts`: the native dispatch table ends at organizations, users, schools, applications, receipts, profile, recruitment, auth, and health. No `/api/articles`, no `/api/news`.
- `apps/homepage/src/lib/host.ts`: stage resolution for `vektor.phibkro.org`, `p###.` preview stages, and the local-only `p000` proof stage; `workers/app.ts` rejects unsupported hosts with 421 and stamps `X-Mono-Web-*` provenance headers.
- `apps/homepage/src/lib/dev-content.ts` and `vite.config.ts`: the entire homepage loader surface is `DEV_CONTENT`; `build-provenance.ts` requires `BUILD_COMMIT`, `BUILD_CONTENT_DIGEST`, and `BUILD_ROUTE_DIGEST` at build time.
- `apps/homepage/src/lib/contact-message.server.ts`: the established homepage pattern for server-side reads through `createHomepageApiClient()` against `API_URL`, including typed 404/503 `Response` throws.
- `packages/domain/src/capabilities.ts`: `Content` depends logically on `ContentManagement`; both are already declared capability names.
- Design spec 0040: `ContentManagement` owns mutable editorial documents, drafts, media, and the publication workflow; `Content` owns publication rules and public content projections; the falsifier "a later content edit changes the historical meaning of an accepted business event".
- Design spec 0055: `OrganizationPersonAuthority` with `globalAdministrator`, memberships, activity intervals, and the half-open-instant laws this contract maps actors from.
- Native precedents: `packages/domain/src/schools/*` (Model.Class variants, one-SQL-file migration, journey program, `SchoolsLive : Layer<Schools, never, Database>`), `apps/backend/src/schools/http.ts`, `packages/sdk/src/domains/admin/schools.ts`, `apps/dashboard/app/routes/__foldkit.schools.ts`, `apps/dashboard/app/foldkit/schools/*`, `apps/dashboard/e2e/run-real-native-schools-directory.mjs` (real Chromium, real login, recording upstream, request ledger).

## Actual product journeys

### Staff editorial journey

1. An authenticated staff member opens `/dashboard/artikler`.
2. The request captures one `authorizationInstant`; Identity resolves the session to one `PersonId`; Organization resolves memberships, leader flags, and the administrator grant at that instant.
3. The workspace lists the caller-visible articles in one snapshot: own drafts for editors, all drafts and published articles for leaders and administrators, each row showing title, slug, status (`Kladd`/`Publisert`), sticky, updated time, departments, and author name.
4. An editor creates a draft with title, body, department selection, and optional image references. The server assigns the slug and the author.
5. The editor revises the draft any number of times. Revisions change the working copy only; nothing public moves.
6. A publisher (active team leader or active global administrator) publishes the draft. One transaction snapshots the working copy into a new immutable published version, records the command receipt and audit fact, and commits.
7. The publisher revises a published article by editing its working copy and publishing again. A new version number is issued; the previous version keeps its bytes and stays resolvable.
8. The publisher unpublishes. The current-version pointer clears in one transaction with receipt and audit; the next public read observes the withdrawal.
9. Every denied step returns a typed rejection: the workspace never guesses why a button was missing.

### Public reader journey

1. An anonymous visitor opens `https://vektor.phibkro.org/nyheter`.
2. The homepage loader performs one server-side read of the published-news listing from the native backend — the same PostgreSQL the editorial authority writes.
3. The page renders summaries newest-first, sticky entries first, with a department filter resolved from the already-native public departments read.
4. The visitor opens `/nyhet/{slug}`; the loader reads the current published version and renders title, author display name, published time, body, and an "other news" sidebar drawn from the same listing read.
5. The front page renders a news teaser from the same listing read; sticky entries lead.
6. A slug that is not currently published returns a real 404 page. A draft is unreachable by guessing: no route serves it anonymously.
7. No step contacts Symfony, the legacy `/nyhet` or `/kontrollpanel` routes, or any fixture source.

## Ownership decision

Design spec 0040 already assigns these capabilities. This contract binds the article journey to them and amends only the implemented-Layer table.

| Fact                                                                                              | Owner                  | Reason                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| Draft rows: title, body, slug assignment, sticky, department associations, working-copy revisions | `ContentManagement`    | Mutable editorial state with low authority profile                           |
| The act of publishing and unpublishing, command receipts, audit facts                             | `ContentManagement`    | Publication is the editorial workflow's transition, not a public-read rule   |
| Immutable published versions and their resolvability                                              | `ContentManagement`    | Versions are written once by the publish transition; nobody else writes them |
| Publication rules: what is visible, ordering, filters, public projection shape                    | `Content`              | Read-time rules over published state, per 0040                               |
| Department identity, active state, names                                                          | `Organization`         | Canonical Organization state; content stores references only                 |
| Person display names of authors                                                                   | `Profile`              | Display projection joined at read time; never copied into content rows       |
| Session-to-PersonId resolution                                                                    | `Identity`             | Spec 0054; untouched here                                                    |
| Image bytes                                                                                       | A later media contract | Upload pipelines are out of scope; this journey stores references only       |

Implemented-Layer amendment to the 0040.2 table:

| Implemented Layer       | Output              | Direct Layer input                    |
| ----------------------- | ------------------- | ------------------------------------- |
| `ContentManagementLive` | `ContentManagement` | `Database`                            |
| `ContentLive`           | `Content`           | `Database`, `Organization`, `Profile` |

Admissions, Recruitment, Economy, Schools, and NotificationGateway are neither logical nor Layer inputs to this journey. `Content`'s logical dependence on `ContentManagement` is realized as read-after-write over distinct tables: `Content` reads only rows that `ContentManagement` transitions write, and writes nothing.

## Actor model

Authorization reuses spec 0055 exactly. There is no content-role table, no editorial permission row, and no new grant type. Each staff request captures one `authorizationInstant`; `Organization.resolvePersonAuthority(personId, instant)` produces the complete projection; the mapper derives the content actor:

| Organization projection                 | Content actor                                  | Powers                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active global administrator             | `ContentAdministrator { personId }`            | See all articles; create, revise, publish, unpublish; may leave departments empty (org-wide article)                                                             |
| Only ended or future grants/memberships | Inactive editor                                | Nothing; typed denial                                                                                                                                            |
| At least one active leader membership   | `ContentPublisher { personId, departmentIds }` | See and revise all drafts scoped to the intersection of `departmentIds`; publish, unpublish those articles; may not publish org-wide (empty-department) articles |
| Active memberships, none leading        | `ContentEditor { personId }`                   | Create drafts carrying at least one department within active memberships; revise own drafts only; see own drafts plus all published articles                     |
| No membership and no grant              | None                                           | Typed `NotInScope`                                                                                                                                               |

Corrections of legacy accidents, stated openly: legacy allowed any team member to tick `Publisert` and to edit any colleague's article without checks. The felt journey treats publication as a leadership act and draft editing as an ownership boundary; this contract narrows both deliberately rather than preserving the missing checks as design. Delete is a separate later contract; nothing in this slice deletes article rows.

The public surface has no actor: listing and detail reads are unauthenticated, require no session cookie, and evaluate no authority. Publishing state alone decides visibility.

## Canonical schemas

`packages/domain/src/content/` declares every fact once with `Model.Class`; persistence, command, observation, and JSON variants derive from those declarations. Unknown properties fail decoding everywhere. Generated, immutable, and private fields are absent from create, update, and JSON variants per the 0047 variant rules.

### Identifiers

- `ArticleId`: positive safe integer, database generated.
- `ArticleVersionNumber`: positive safe integer, starting at 1.
- `ArticleSlug`: lowercase `[a-z0-9-]+`, maximum 255, non-empty, branded text.

### ArticleDraft (ContentManagement)

| Field                  | Schema                                | Rule                                                                      |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `articleId`            | `ArticleId`                           | Database generated and immutable; absent from create JSON                 |
| `title`                | non-empty string, maximum 255         | Stored verbatim after outer whitespace validation                         |
| `slug`                 | `ArticleSlug`                         | Assigned by the server at creation; immutable afterwards                  |
| `bodyHtml`             | sanitized HTML string, maximum 100000 | Sanitized at every write; see the editorial laws                          |
| `sticky`               | boolean                               | Defaults to false; only publishers may set true                           |
| `createdByPersonId`    | `PersonId`                            | Server-set from the actor; private: absent from every public JSON variant |
| `createdAt`            | instant                               | Database generated                                                        |
| `updatedAt`            | instant                               | Database generated on every working-copy write                            |
| `currentVersionNumber` | `ArticleVersionNumber?`               | Null while draft; set by publish; cleared by unpublish                    |
| `revision`             | nonnegative integer                   | Optimistic concurrency token; absent from create JSON                     |

`ArticleDraft` has select, insert, update, JSON-read, JSON-create, and JSON-update variants. The staff JSON variant additionally carries `authorDisplayName`, `status` (`Draft` | `Published`), and `departmentIds`; it never carries another person's `createdByPersonId` to a mere editor.

### PublishedArticleVersion (ContentManagement)

Immutable after commit. No update variant exists.

| Field                 | Schema                        | Rule                                              |
| --------------------- | ----------------------------- | ------------------------------------------------- |
| `articleId`           | `ArticleId`                   | References the draft row                          |
| `versionNumber`       | `ArticleVersionNumber`        | Unique per article, increments by one per publish |
| `title`               | non-empty string, maximum 255 | Snapshot of the working copy at publish           |
| `slug`                | `ArticleSlug`                 | Snapshot; equal to the draft slug                 |
| `bodyHtml`            | sanitized HTML string         | Snapshot                                          |
| `sticky`              | boolean                       | Snapshot                                          |
| `publishedAt`         | instant                       | Transaction instant of the publish command        |
| `publishedByPersonId` | `PersonId`                    | Private: absent from every public JSON variant    |

### ArticleDepartment

`(articleId, departmentId)` is the semantic identity; composite primary key. `departmentId` references `organization_departments` with `ON DELETE RESTRICT`. Editors select departments only within their active scope; administrators may store an empty set, meaning org-wide.

### Workspace observation (staff)

`ContentWorkspaceEntry` contains exactly: `articleId`, `title`, `slug`, `status`, `sticky`, `updatedAt`, `departmentIds`, `canRevise`, `canPublish`, `authorDisplayName`. `ContentWorkspace` contains exactly `{ entries: ContentWorkspaceEntry[] }`, ordered by `updatedAt DESC`, then `articleId DESC`. `canRevise`/`canPublish` are pure projections of the actor matrix; they never widen authority.

### Public projections (Content)

`PublishedNewsSummary` contains exactly: `slug`, `title`, `sticky`, `publishedAt`, `authorDisplayName`, `departmentIds`, `hasImage`, `imageUrl?`. `PublishedNewsListing` contains exactly `{ articles: PublishedNewsSummary[] }`, ordered sticky-first then `publishedAt DESC` then `articleId DESC`, complete in one response. `PublishedNewsArticle` contains exactly one summary plus `bodyHtml` and `previousVersions: { versionNumber, publishedAt, urlPath }[]` sorted descending. Every decoder rejects excess properties. `authorDisplayName` comes from a Profile read inside the same snapshot; a missing profile for a published version is a typed integrity failure, never an opaque identifier.

## Editorial and publication laws

1. Slug: generated at draft creation from the title with the legacy transliteration (`æøå` to `ae/o/a`, lowercase, `[a-z0-9-]`), deduplicated with the deterministic `-2`, `-3`, … suffix; unique across drafts and all published versions; never regenerated; immutable for the article's life.
2. Publish: one transaction verifies the actor matrix, locks the article row (advisory lock on `articleId`), sanitizes, inserts the next `PublishedArticleVersion`, sets `currentVersionNumber`, and writes the command receipt and audit fact. All rows commit or none.
3. Version immutability: committed version rows are never updated or deleted. A revised republication issues `versionNumber + 1`. The previous version keeps its bytes and stays resolvable at its stable version path while the article is published.
4. Unpublish: one transaction clears `currentVersionNumber` and writes receipt and audit. The canonical slug stops resolving publicly at the next read; historical versions stop resolving with it. Republishing continues the version sequence; numbers are never reused.
5. Draft invisibility: public reads join only rows with a non-null current version. No public route, decoder, or error message distinguishes an existing draft from a nonexistent slug.
6. Body safety: stored `bodyHtml` passes the write-time sanitizer, which removes `script` and `iframe` contexts (the legacy `safe_html` blacklist) and refuses unclosed-document payloads; public responses emit only sanitized bytes. Stored bytes can never inject script into a public response regardless of which client wrote them.
7. Ordering: public listing order is `sticky DESC, publishedAt DESC, articleId DESC`; the legacy 30-day window and the broken `orWhere` are corrected accidents and are not restored.
8. Snapshots: every staff and public read materializes completely in one read-only snapshot; a retry captures a new instant; no read mixes authority facts or rows across snapshots.
9. Command replay: identical `commandId` replays return the stored observation and write nothing; a reused `commandId` with different canonical bytes fails with a typed conflict; concurrent publish and unpublish serialize under the article lock with one database order.
10. Pagination is a pure projection of the fully loaded listing (page size 10 on `/nyheter`); it never starts a second server read.
11. No read or command in this slice writes Organization, Profile, Admissions, Recruitment, Economy, or Schools rows, emits notifications, or touches files.

## Authority matrix

Every staff request captures one `authorizationInstant` after session decoding; all rows use that instant.

| Caller projection                                         | Result                                      |
| --------------------------------------------------------- | ------------------------------------------- |
| Missing or invalid session                                | HTTP 401, `UnauthenticatedActor`            |
| Active global administrator                               | HTTP 200 on every staff operation           |
| Active team leader, article intersects leader departments | HTTP 200, including publish and unpublish   |
| Active team leader, org-wide (empty-department) article   | HTTP 403, `NotInScope`                      |
| Active member, own draft, revise/list                     | HTTP 200                                    |
| Active member, foreign draft, or any publish/unpublish    | HTTP 403, `NotPublisher` or `DraftNotOwned` |
| Memberships or grants exist but none active               | HTTP 403, `AuthorityInactive`               |
| No membership or administrator record                     | HTTP 403, `NotInScope`                      |

An optional `department` filter on the staff workspace narrows the authorized set; it can never create authority. An unknown department id is HTTP 422; a known department outside scope is HTTP 403. Sticky changes ride the publish/revise commands and require publisher authority.

## Service and Layer contract

Two Effect `Context.Tag` Services, per 0045.2:

```text
ContentManagement (editorial authority)
  createDraft(command, context)      -> ArticleDraftJson
  reviseDraft(command, context)      -> ArticleDraftJson
  publish(command, context)          -> PublishObservation
  unpublish(command, context)        -> UnpublishObservation
  readWorkspace(query, context)      -> ContentWorkspace
  fails: UnauthenticatedActor | AuthorityInactive | NotInScope
       | NotPublisher | DraftNotOwned | SlugConflict | CommandConflict
       | ContentDecodeError | ContentPersistenceError

Content (publication-rules authority)
  readNewsListing(query)             -> PublishedNewsListing
  readPublishedArticle(slug)         -> PublishedNewsArticle
  fails: ArticleNotFound | ContentIntegrityError | ContentDecodeError
```

Named journey programs, not second Services:

```text
runContentWorkspace(personId, authorizationInstant, query)
  requires Database | Organization | ContentManagement
runPublicationTransition(personId, authorizationInstant, command)
  requires Database | Organization | ContentManagement
readPublicNews(query)
  requires Database | Organization | Profile | Content
```

Structural Layer types:

```text
ContentManagementLive : Layer.Layer<ContentManagement, never, Database>
ContentLive           : Layer.Layer<Content, never, Database | Organization | Profile>
```

Neither Live layer constructs Database, Organization, or Profile. The composition root builds each layer once, merges them into the existing capability graph, and disposes them with the ManagedRuntime. HTTP adapters import no SQL client: they decode transport input, invoke journeys, and map typed results to statuses.

## Persistence and migration contract

The Content slice owns `packages/domain/src/content/migrations/0001-content-publication.sql`. The application manifest imports it as the next ordered migration, registry key `20_content-publication`, and `databaseSchemaRevision` advances to `20_content-publication`. Tests and runners replay that same source against PGlite and PostgreSQL.

The migration creates exactly these tables:

1. `content_articles` — the editorial working copies (`ArticleDraft`).
2. `content_article_versions` — immutable published snapshots, unique `(article_id, version_number)`, unique `(slug, version_number)`.
3. `content_article_departments` — composite primary key `(article_id, department_id)`; `department_id` references `organization_departments` `ON DELETE RESTRICT`; `article_id` cascades.
4. `content_publication_command_receipts` — command id primary key, article, kind, payload digest, result digest.
5. `content_publication_audit` — append-only publication history with immutable identity.

Supporting indexes: unique `slug` on `content_articles`; partial listing index on `(sticky DESC, published_at DESC, article_id DESC)` over `content_article_versions` rows that are their article's current version; `current_version_number` foreign-key index. Slug uniqueness spans both tables through the creation-time transactional check plus per-table unique constraints; a lost race yields typed `SlugConflict`, never a silent rewrite.

There is no legacy-row import and no production backfill. Migrating legacy `article` rows requires a separate frozen contract and operator authority. No fixture seeds ship in product branches; disposable seeds create their rows in dependency order (persons, Organization state, then content).

## HTTP boundaries

The native backend adds exactly these staff endpoints:

```text
GET    /api/admin/content/workspace?department=<DepartmentId>
GET    /api/admin/content/articles/{articleId}
POST   /api/admin/content/articles
PUT    /api/admin/content/articles/{articleId}
POST   /api/admin/content/articles/{articleId}/publish
POST   /api/admin/content/articles/{articleId}/unpublish
```

Any other query parameter fails strict decoding with HTTP 422. Failure mapping is exact:

| Failure                                                            | HTTP status |
| ------------------------------------------------------------------ | ----------- |
| Missing or invalid session                                         | 401         |
| `AuthorityInactive`, `NotInScope`, `NotPublisher`, `DraftNotOwned` | 403         |
| Unknown article                                                    | 404         |
| Malformed body, unknown query, slug-rule violation                 | 422         |
| `CommandConflict`                                                  | 409         |
| Database or row decode failure                                     | 503         |

The native backend adds exactly these public endpoints:

```text
GET /api/news?department=<DepartmentId>
GET /api/news/{slug}
```

Both are unauthenticated. Unknown department id is 422; unknown or unpublished slug is 404 with a body indistinguishable from any other 404. Responses carry `Cache-Control: no-store`, so no intermediate cache can serve withdrawn content; unpublish is observable at the very next read.

No native route answers `/api/articles`, `/articles{...}`, or any legacy article URI template. The parity inventory keeps accounting those rows under the accepted intents; the native backend serves no alias, forward, or compatibility shape. The Symfony processes keep their routes until decommissioning outside this contract; no native caller reaches them.

## SDK boundary

The SDK adds two strict domains:

```text
client.admin.content.workspace({ department? })
client.admin.content.read(articleId)
client.admin.content.createDraft(command)
client.admin.content.reviseDraft(command)
client.admin.content.publish(command)
client.admin.content.unpublish(command)

client.public.news.list({ department? })
client.public.news.read(slug)
```

Each method makes one strict request, decodes with Effect Schema from `packages/sdk/src/schemas/content.ts`, rejects excess properties, and surfaces typed tagged errors (`ContentRejectionError` with domain tags, `ContentDecodeError`, `UnauthorizedError`, `NetworkError`). No Hydra envelope, JSON-LD field, page walker, or fallback shape exists. The homepage consumes only `client.public.news.*` through the server loader; the dashboard consumes only `client.admin.content.*` through the Foldkit bridge.

## Full-Foldkit state ownership

`/dashboard/artikler` mounts one `vektor-article-workspace` custom element. React Router owns route matching, authenticated loading, and strict runtime decoding of the element attribute; it owns no article state.

Foldkit owns: remote `AsyncData`, the workspace listing, the selected article, the editor form values (title, body, department checkboxes, sticky), dirty-state tracking, command in-flight state, request identity, retry count, stale-response rejection, success/failure/denial banners, empty/loading/ready states, and every rendered row.

Legal transitions include at least:

| Message                                   | Transition                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SelectedArticle(articleId)`              | Issue one strict working-copy detail read; load body and revision only for a current matching response; clear stale banners |
| `EditedField(change)`                     | Mark dirty; validate locally; send nothing                                                                                  |
| `SubmittedCreate` / `SubmittedRevise`     | Issue one decoded command under a new request id                                                                            |
| `SucceededSave(workspace)`                | Replace the Model only when the request id matches; clear dirty                                                             |
| `SubmittedPublish` / `SubmittedUnpublish` | Require publisher capability in the Model; issue one command                                                                |
| `FailedCommand(tag)`                      | Show the typed safe failure and preserve selection/editor bytes; invalidate the selected revision after `CommandConflict`   |
| `ChangedDepartmentFilter(departmentId?)`  | Narrow the visible rows; no new server request                                                                              |

Commands travel the same-origin bridge route (`__foldkit.content.ts`) using only `client.admin.content.*`; the bridge maps tags to statuses exactly like the schools bridge. A retry creates a new request id; a stale success or failure leaves the Model unchanged. React owns no `useState`, `useEffect`, `useFetcher`, loader fetch, or fallback data. The navigation marks `Artikler` as a staff link visible to members and up.

## Homepage public surface contract

The homepage adds three server-rendered routes: `nyheter.tsx` (listing), `nyhet.$slug.tsx` (detail), and a front-page news teaser section on `_home._index.tsx`. All three loaders run only on the server, call `client.public.news.list()`/`read()` through `createHomepageApiClient()` against `API_URL`, and throw typed `Response`s (404 for unknown slug, 503 for upstream decode or persistence failure) exactly like the contact-message seam.

Laws:

1. Every render performs its own fresh read; no module-level cache, no build-time snapshot, no `loader`-shared mutable state.
2. There is no fixture fallback. `DEV_CONTENT` keeps feeding sponsors, teams, and statistics until their own journeys cut over, but no article byte ever comes from `dev-content`, and the news routes render no synthetic placeholder article.
3. The department filter resolves visitor-facing city names to department ids through the already-native `client.public.organization.listDepartments()`; an id that vanishes between reads degrades to the unfiltered listing with a visible notice, never to fabricated rows.
4. The teaser shows the first five summaries of the same listing read; sticky leads; imageless entries render without an `<img>` element.
5. Detail pages resolve prior versions from `previousVersions` and link them; they never refetch per version on the server.
6. Host resolution is unchanged: the routes behave identically on `p000` local proofs, `p###` previews, and the apex `dev-main` stage, and the 421 invalid-host path is untouched.
7. Build provenance is unchanged mechanically: `BUILD_CONTENT_DIGEST` and `BUILD_ROUTE_DIGEST` continue to hash the declared content and route manifests, which now simply include the three news routes; no digest is computed from fetched articles.
8. Navigation adds `Nyheter`; no navigation entry points to a draft or staff URL.

## Disposable seed and evidence plan

The seed is local and disposable, created in dependency order:

1. Better Auth users and credential accounts for the personas.
2. Profile persons and contacts.
3. Organization departments, teams, memberships, leader flags, and one administrator grant.
4. Articles: drafts in mixed states, published articles across departments, one org-wide (empty-department) published article, one sticky entry, one multi-department article, one article with two published versions.

Personas: one active global administrator; one active team leader in department A; one active member in department A (an author); one active member in department B; one person with only an ended membership; one person with no Organization record.

The evidence contains these parts:

1. Model checks: every derived variant, excess-property rejection, private-field absence (`createdByPersonId`, `publishedByPersonId` never in public JSON), slug grammar, sanitizer acceptance and refusal cases.
2. Pure actor-matrix checks for every row at exact interval boundaries, including leader-vs-administrator org-wide scoping.
3. Pure projection checks: listing ordering, sticky partition, department filtering, pagination slicing, `canRevise`/`canPublish` derivation.
4. PGlite checks: migration replay to revision `20_content-publication`, unique constraints, version-number sequencing, foreign keys.
5. PostgreSQL checks: one publish commits version, pointer, receipt, and audit atomically under a concurrent unpublish; one full listing read keeps one snapshot across a concurrent publish; slug races yield typed conflicts.
6. HTTP checks: 401; every 403 row; 404 staff and public; 409 conflict; 422 strict-query cases; public no-store headers; draft-slug public 404 indistinguishability.
7. SDK checks: one strict request per method, excess-property and Hydra rejection, typed error mapping.
8. Foldkit Update checks: every transition above, stale-result rejection, retry identity, denial rendering.
9. Accessibility checks: heading structure, labelled form controls, table semantics, alert roles, keyboard operability of the editor pane.
10. Real-session Chromium checks against disposable PostgreSQL, the native backend, the dashboard, and the homepage worker, driven by a `run-real-native-content-publication.mjs` runner modeled on the schools runner.

The browser journey signs in through the real login page and never injects a bearer token. It drives the full staff arc — create, revise, publish, revise, republish, unpublish — with the administrator and leader personas, observes typed denials for the plain member and the authority-less personas, and then, in an anonymous second context with no shared cookies, reads the public listing and detail pages: published content visible with correct author name and ordering, the old version still resolvable after republication, and the article absent from listing and canonical URL after unpublish. A request ledger records every upstream call and must contain zero Symfony requests, zero `/kontrollpanel` or legacy `/nyhet` hits, and zero fixture-server requests. PGlite never stands in for PostgreSQL concurrency proof.

### Runtime receipt invocation

The native Content runner emits no repository receipt by default. To request one, set all four runtime-evidence variables and use a JSON path under `evidence/functional-parity/runtime/`; the runner writes canonical schema-validated bytes only after the real Chromium journey passes:

```sh
RUNTIME_EVIDENCE_RECEIPT_PATH=evidence/functional-parity/runtime/content-0062.json \
RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID=<selected-legacy-revision> \
RUNTIME_EVIDENCE_MONO_REVISION_REF_ID=<tested-mono-revision> \
RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS=<runner-source-ref>,<spec-source-ref> \
bun run --cwd apps/dashboard e2e:real-content-publication
```

The receipt path is confined to the declared repository evidence directory. An ordinary run writes no repository evidence.

## Definition of done

1. This frozen spec precedes any implementation commit for content publication.
2. `packages/domain/src/content/` declares `ArticleDraft`, `PublishedArticleVersion`, `ArticleDepartment`, and the boundary schemas once, deriving every persisted and JSON variant; private person-id fields are absent from all public JSON variants.
3. Migration revision `20_content-publication` creates exactly the five content tables, is imported as the next ordered migration, and `databaseSchemaRevision` equals `20_content-publication` in both PGlite and PostgreSQL runs.
4. `ContentManagementLive` and `ContentLive` expose exactly the declared operations with the declared structural Layer requirements, built once and disposed once in the composition root; no adapter imports SQL.
5. Every staff operation resolves one `OrganizationPersonAuthority` at one captured `authorizationInstant` inside its command transaction, and the actor matrix reproduces every row of the authority matrix with the named typed denials.
6. A member can create and revise only own, department-scoped drafts; a leader can publish, unpublish, and revise intersection-scoped articles; an administrator spans all; inactive and absent-authority callers receive typed 403s — never empty successes.
7. Publish atomically writes the immutable version, the current-version pointer, the receipt, and the audit row, or nothing; identical command replay returns the stored observation and writes nothing; conflicting replay fails with 409.
8. Revising a published article and republishing yields `versionNumber + 1` while the previous version keeps its bytes and remains resolvable at its stable path.
9. Unpublish removes the article from the public listing and turns the canonical slug into a public 404 within one fresh read; republishing continues the version sequence without reusing numbers.
10. A draft is invisible to every public route and indistinguishable from a missing slug.
11. `GET /api/news` and `GET /api/news/{slug}` return the exact strict public shapes with `Cache-Control: no-store`, and no native route serves any legacy article URI template.
12. The SDK exposes only `client.admin.content.*` and `client.public.news.*` with strict decoding; no Hydra shape, page walker, or fixture fallback exists anywhere in the chain.
13. `/dashboard/artikler` is a full-Foldkit owner with no React interaction state, covering draft, revise, publish, and unpublish with typed denial banners.
14. The homepage serves `/nyheter`, `/nyhet/{slug}`, and the front-page teaser from fresh server-side reads of the same authoritative database, with zero article bytes sourced from `dev-content` or fixtures.
15. Stored body HTML cannot deliver `script` or `iframe` content into any public response.
16. Focused model, migration, database, HTTP, SDK, Foldkit, accessibility, and real-session browser checks pass over deterministic non-production data.
17. The browser request ledger records zero Symfony, legacy article-route, or fixture-server requests during both the staff and anonymous public journeys.
18. No production import, dual write, compatibility endpoint, credential change, deployment, or external effect occurs; identity remains exactly spec 0054's cutover, untouched.
19. The only amended staff route is `GET /api/admin/content/articles/{articleId}`; strict route tests reject aliases and unknown query parameters.
20. Fresh-load browser evidence selects an existing row, observes the exact private working-copy projection without `createdByPersonId`, proves a stale revision returns typed `CommandConflict`, reloads detail, and then completes a repeated revision.

## Falsifiers

This contract is incomplete or violated if one condition occurs:

- A content-role, editorial-permission, or publisher-grant table appears beside the Organization authority.
- A publish, unpublish, or sticky decision reads a bearer-token map, session role string, or an authority projection from an earlier request.
- A committed published version row is updated, deleted, or renumbered.
- Republication rewrites the bytes or resolvability of an earlier version.
- A draft is listed, rendered, or distinguishable on any public route, including error behavior.
- An inactive or authority-less person receives an empty HTTP 200 instead of a typed 403.
- A plain member publishes, unsticks, or revises a foreign draft.
- A team leader publishes an org-wide (empty-department) article.
- Two published versions of one article share a version number, or a reused number reappears after unpublish.
- Two articles, drafts, or versions share one slug.
- A public response carries `Cache-Control` that permits serving withdrawn content after unpublish.
- A public JSON payload contains `createdByPersonId`, `publishedByPersonId`, or any draft body.
- Stored body bytes reach a public response with executable script or iframe content intact.
- The public listing restores the broken sticky/orWhere window semantics or mixes snapshots within one response.
- An HTTP adapter imports SQL, computes a projection, or constructs a Layer, ManagedRuntime, or pool.
- The native backend answers any legacy article URI template as an alias or forwarder.
- The SDK accepts a Hydra envelope or excess properties on any content method.
- React owns workspace data, editor form values, dirty tracking, retry state, or a fetch effect.
- Any homepage news byte originates from `dev-content`, a build-time snapshot, or a fixture module.
- A disposable seed or checked-in scan is presented as production-import approval, or PGlite output is reported as PostgreSQL concurrency proof.
- The browser ledger records a Symfony, legacy article-route, or fixture-server request.

## Non-goals

This contract does not authorize article deletion, comment or feedback surfaces, changelog, social-event, static-content, sponsor, or support-ticket journeys; those Content-domain neighbors remain legacy-accounted until their own contracts.

It does not implement image upload or media storage; articles in this slice carry optional image references only, and the media contract arrives separately.

It does not migrate legacy article rows, backfill production data, or decommission Symfony article routes; removal of the legacy surface requires operator authority outside this document.

It does not move the news pages onto admission-journey data (department news widgets stay with Admissions), does not add mailing or notification effects, and does not touch Identity credentials, sessions, or the 0054 cutover in any way.
