# Design spec 0080 - native API reference as primary IA

## Metadata

| Field | Value |
| --- | --- |
| Status | Frozen before implementation |
| Source repository | `/tmp/mono-web-final-integration` |
| Source branch | `integration/0062-final` |
| Source commit | `29d973519cdfb72b58ce989326eb689af2a716d3` |
| Worktree | `/tmp/mono-web-api-reference-ia` |
| Branch | `feat/0080-api-reference-ia` |
| Amends | `design-specs/0079-generated-api-and-code-reference.md` (IA only) |
| Design steering | TMDB developer portal reference patterns (patterns, not content) |
| Public native operation total | 47 (unchanged) |
| Spec extensions allowed | `x-tagGroups`, `x-displayName`, `examples` via generator + Effect Schema annotations |

## Goal

Make the generated native API reference the primary product of the documentation site.
The reference gets the first top-nav entry after Home, its own resource-grouped sidebar,
truthful request/response/error examples at every representative operation, and a
source-cited authentication and authorization guide. Diataxis content remains complete
but becomes the second entry.

This spec amends the information architecture of 0079 only. Canonical sources,
determinism, drift gates, and the code reference of 0079/0079.1 remain binding.

## Information architecture (before and after)

Before (0079 state): topNav is `Tutorials, Routes & API, How-to, Reference, Explanation`.
The generated reference lives at `/reference/native-api` behind the Reference sidebar.

After (this spec):

1. topNav order: `API Reference` (`/reference/native-api`, entry 1 after Home),
   `Docs` (`/tutorials/orientation`, entry 2, the Diataxis area), then the human
   `Routes & API` entry stays available inside Reference.
2. The API Reference section (Vocs OpenAPI mount) owns an isolated sidebar with
   resource-group sections from `x-tagGroups`, an intro group containing the
   overview, the authentication guide, the errors guide, and the human
   `Routes & API` overview link.
3. The Diataxis sidebar (Tutorials, How-to, Reference, Explanation) keeps all
   existing entries; `Native API reference` moves out of the Reference sidebar
   list because the mount owns it; all other entries stay.
4. `/reference/routes-and-api` remains the human entry point into the reference
   and links to the generated operations and the authentication guide.

## Tag groups (generator-owned)

`x-tagGroups` and `x-displayName` are added by the Effect contract annotations in
`packages/http-api/src` (group `OpenApi.annotations` and API-level `override`), never by
hand-editing `openapi.json`. The generated document gains:

- `x-displayName` on each tag via the existing group titles: System, Profile,
  Organization, Directories, Admissions, Recruitment, Receipts, Content and news.
- One document-level `x-tagGroups` entry per named resource section:
  - `Platform` (System, Profile)
  - `Directories` (Organization, Directories)
  - `Admissions` (Admissions)
  - `Recruitment` (Recruitment)
  - `Economy` (Receipts)
  - `Content` (Content and news)
- `OpenApi.fromApi` emits `override` annotations verbatim; the generator asserts
  `x-tagGroups` is present, has exactly these six sections in this order, and covers
  all eight tags exactly once.

## Examples at the source (Effect Schema annotations)

Every example is attached in `packages/http-api/src` with
`.annotate({ identifier, description, examples: [...] })` on the exact schema the
endpoint references, so `OpenApi.fromApi` projects it into
`components.schemas.<Name>.examples`. Vocs renders response example blocks from
schema `examples` and request samples from payload schema `examples` (verified
against the installed Vocs 2.8.5 sample builder: `schema.examples[0]` wins).
Error schemas use the shared `errorBody`/`receiptErrorBody` helpers, which gain a
truthful example per status family. All values mirror handler/domain behavior:

- System: `HealthOkResponse` `{status:"ok"}`, `HealthUnavailableResponse`
  `{status:"unavailable"}`, `SessionResponse` `{personId, expiresAt}` (already present).
- Profile: `UserProfileResponse` example with `ROLE_TEAM_MEMBER` role; 401
  `SessionUnauthorizedResponse` `{error:{tag:"UnauthenticatedActor"}}`; 403
  `{error:{tag:"AuthorityInactive"}}`; 404 `{error:{tag:"ProfileNotFound"}}`.
- Organization: department, team, and field-of-study JSON examples consistent with
  `Department.json`/`Team.json`/`FieldOfStudy.json` fields; command payloads
  (`_tag`, `commandId`, bounded fields); 403 `OrganizationRoleDenied`; 409
  `OrganizationCommandConflict`; 413 `RequestBodyTooLarge`; 422
  `OrganizationInvalidReference`; 503 `OrganizationPersistenceError`.
- Directories: `AdminUserDirectoryResponse` and `SchoolDirectorySchema` examples
  (language literal `"Norwegian"`, active/inactive split, `nextCursor: null`);
  403 `NotInScope`; 422 `DirectoryCursorMalformed`.
- Admissions: `CreateAdmissionPeriodPayload` and `ReviseAdmissionPeriodPayload`
  examples (RFC-3339 instants); public submit input example with `gender: 1`,
  `yearOfStudy: 1`; 404 `PublicApplicationNotFound`; 409
  `DuplicatePublicApplication`; 429 `PublicApplicationRateLimitExceeded`.
- Recruitment: invitation read observation example (Pending variant with
  `scheduledAt`, `room`, `campus`, `responseMessage: null`); reject body
  `{message:"..."}`; request-new-time body; assignment/schedule/finalize/cancel
  command examples with `commandId`, `expectedRevision`, answers, 0..10 scores;
  401 `SessionUnauthorizedResponse`; 404 `RecruitmentInvitationNotFound`;
  409 `RecruitmentInterviewStaleRevision`.
- Receipts: multipart field description example (form fields `commandId`,
  `description`, `amountOre`, `receiptDate`, file `file`); `ReceiptRevisionCommand`
  example (already present); owner list item example with `currency:"NOK"`,
  `status:"Pending"`, `amountOre` integer; 403 with the two composed-denial
  messages exactly as the backend emits them: `{"error":{"tag":"AmbiguousParameterFill",
  "message":"Authorization parameter fill is ambiguous"}}` and
  `{"error":{"tag":"FailedComposedRequirement","message":"Composed authorization
  requirement failed"}}`; 404 `ReceiptNotFound`; 409 `StaleReceiptRevision`.
- Content: workspace entry, draft, detail, publish/unpublish observation examples
  (`_tag:"Published"`, `versionNumber`); news summary example with lowercase slug;
  403 `DraftNotOwned`; 404 `ArticleNotFound`; 409 `CommandConflict`.

Rules:

1. An example must decode against its own schema. The generator validates this by
   running `Schema.decodeUnknownSync` (or `Schema.decodeSync`) on each attached
   example for every annotated schema it knows, failing generation otherwise.
2. Error examples use only tags that the endpoint's schema already lists.
3. No invented fields; every example field exists in the referenced schema or the
   handler output it mirrors. Composed-denial messages are copied from
   `COMPOSED_DENIAL_MESSAGES` in `apps/backend/src/receipt/http.ts`.
4. Status set is unchanged: the contract has no 400 status anywhere (verified:
   0 occurrences of `"400"` in generated `openapi.json`); malformed requests
   surface as 422 decode responses.

## Regeneration and gates

- `packages/http-api` regenerates `openapi.json`; `generate:check` stays
  byte-stable, non-mutating, and green.
- Public operation count stays exactly 47; every operationId stays
  `<group>.<endpoint>` and the id set is unchanged; no `/api/auth/*` and no
  internal evidence path appears; no production server URL appears.
- The docs landing page generator (`apps/docs/scripts/generate-openapi-reference.ts`)
  keeps producing `src/pages/reference/native-api/index.mdx` (still generated,
  still byte-stable) and links the new authentication guide and the human overview.
- Two consecutive docs generation runs produce identical bytes; `generate:check`
  stays non-mutating.

## Authentication and authorization guide

One new hand-written page `src/pages/reference/authentication.mdx` inside the
API Reference intro sidebar ("Authentication & authorization"). Every claim cites
the source file that owns the behavior. Content sections:

1. How sessions work: Better Auth email+password sign-in (`POST /api/auth/sign-in/email`
   with `{email, password}`) issued by `makeAuthEngine` in
   `packages/database/src/auth-engine.ts`; the engine issues the
   `better-auth.session_token` HttpOnly cookie (7-day expiry, 5-minute cookie cache);
   `Identity.resolveSession` in `packages/database/src/auth-live.ts` resolves that
   cookie to a person and fails closed with `IdentitySessionNotFound` for unknown
   or revoked cookies; sign-out is `Identity.signOut`.
2. How requests authenticate: every session-protected endpoint declares
   `SessionSecurity` (`packages/http-api/src/common.ts`); the backend resolves the
   request `Cookie` header through `resolvePersonAuthority` in
   `apps/backend/src/authority.ts` (Cookie -> Identity session -> person -> one
   `authorizationInstant` -> Organization authority projection) at one instant per
   request.
3. Session validation: `GET /api/me/session` returns `{personId, expiresAt}` or 401
   `{"error":{"tag":"UnauthenticatedActor"}}` (503 `IdentityEngineError` on
   infrastructure failure).
4. Role and authority model: `OrganizationPersonAuthority` carries
   `globalAdministrator: Active|Inactive|Absent` plus memberships with
   `active` and `teamLeader` flags (`packages/domain/src/organization/authority.ts`);
   mappings produce the frozen actor contracts for Admissions/Recruitment
   (`GlobalAdmin`/`DepartmentLeader`/`Member`), Profile roles
   (`ROLE_ADMIN`/`ROLE_TEAM_LEADER`/`ROLE_TEAM_MEMBER`), receipts owner/approver
   authority, and content author/publisher scope.
5. Invitation capability scheme: the four recruitment invitation endpoints use the
   `X-Recruitment-Invitation-Capability` header with a 43-character base64url token
   (`RecruitmentInvitationCapabilitySchema` in
   `packages/domain/src/recruitment/schema.ts`); the backend reads it in
   `apps/backend/src/recruitment/http.ts` and maps missing/malformed/unknown
   capabilities to 404 `RecruitmentInvitationNotFound`; no session is required.
6. Errors: the `{error:{tag}}` envelope for every group, the receipt
   `{error:{tag,message}}` composed-denial variants, and the concrete example
   bodies now carried in `openapi.json` for 401/403/404/409/413/422/429/503;
   explicit statement that the native API has no 400 status.
7. Getting started (first call): a runnable order mirroring TMDB's validate-first
   pattern: health check -> `GET /api/me/session` with the cookie -> one
   authenticated read (`GET /api/me` or `GET /api/receipts`) -> one rejected call
   showing the exact 401 body. All claims are verified against handler code; nothing
   is asserted beyond what the code does.

## Vocs configuration

`vocs.config.ts` changes:

- topNav becomes `API Reference`, `Docs`, `Routes & API` (keeps the human overview
  one click away).
- The OpenAPI mount sidebar gains `intro` items: the authentication guide page and
  the human `Routes & API` page, rendered under Introduction next to Overview.
- The Diataxis sidebar drops the `Native API reference` entry (owned by the mount
  now) and keeps every other existing entry; the Reference group keeps
  `Routes & API`, code reference, and the generated Markdown siblings.

## Verification

1. `bun run --cwd packages/http-api generate` then `generate:check` twice: byte-stable,
   non-mutating, green; 47 operations; unique ids; excluded paths absent.
2. Docs `generate:check` twice: identical bytes, non-mutating.
3. Docs `check-types`, `lint`, `format:check`, `build` green.
4. Browser smoke of the built docs: API Reference landing, one operation page per
   resource section, the authentication guide; each returns 200, shows the grouped
   sidebar and example blocks, and reports no console or request errors.
5. Root `format:check`, `check-types`, `lint`, `build`, `test` are run once,
   sequentially, after the concurrent parity lane finishes (operator-directed).
6. No push, no deploy, no provider, no shared database. Commits use pathspecs.

## Falsifiers

This implementation fails the spec if any of these are true:

- `openapi.json` is hand-edited instead of regenerated from the contract
- an example value contradicts a schema constraint or handler behavior
- the public operation count, any operationId, or any status set changes
- `x-tagGroups` misses a tag or invents a tag that does not exist
- the authentication guide asserts behavior without a code source
- the Diataxis area loses pages or entries
- generated outputs are no longer byte-stable or checks mutate tracked files
- the root gates are skipped or run concurrently with the parity lane

## Acceptance

1. This frozen spec is committed before implementation.
2. API Reference is topNav entry 1 after Home with a resource-grouped sidebar.
3. Examples exist for representative success and error responses in all eight groups.
4. The authentication and authorization guide exists, is sidebar-reachable, and cites code.
5. All focused gates pass; root gates are executed once the parallel lane completes.
6. The worktree ends clean with coherent pathspec commits.
