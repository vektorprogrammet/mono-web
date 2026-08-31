# Design spec 0077 - native Effect HttpApi contract

## Metadata

| Field | Value |
| --- | --- |
| Status | Frozen before implementation |
| Source repository | `/tmp/mono-web-final-integration` |
| Source branch | `integration/0062-final` |
| Source commit | `909250661f7ff0b29432d3dfd770ae11a1e70341` |
| Worktree | `/tmp/mono-web-httpapi-contract` |
| Branch | `feat/0077-effect-httpapi` |
| Effect authority | Official and installed `effect@4.0.0-rc.109` source only |
| Native endpoint total | 48: 47 documented operations and 1 internal evidence operation |
| External exclusion | Better Auth `/api/auth/*` for every method |

## Goal

Replace the native backend's manual Fetch method/path dispatch with one real Effect `HttpApi`.
`packages/http-api` is the dependency-light canonical contract. It owns method, path, runtime
request/response/error schemas, security declarations, operation identifiers, descriptions, and
OpenAPI annotations. `apps/backend` owns the handlers and process composition.

`OpenApi.fromApi(NativeApi)` is the only OpenAPI source. The repository owns the deterministically
generated OpenAPI 3.1 artifact at `packages/http-api/openapi.json` and a generator with a `--check`
drift gate. The document title is **Vektorprogrammet native preview API**. It has no production
server URL.

## Semantic boundary and ownership

| Input kind | Boundary | Validation and authority | Observation/effect owner |
| --- | --- | --- | --- |
| Query | HttpApi endpoint query schema plus route-specific compatibility checks | Exact current duplicate, unknown-key, and empty-value behavior | Handler invokes one domain query effect |
| Command | HttpApi payload schema; multipart routes retain file, size, staging, and cleanup checks | Session/capability resolves before the domain command at the same points as today | Domain Service owns transition and replay semantics |
| Path identity | HttpApi path parameter schema | One decoded segment; route-specific positive integer/brand checks | Handler passes the decoded identity to the domain Service |
| Cookie session | Session security declaration and backend identity resolver | Better Auth session -> `Identity` -> Organization authority at one request instant | Existing Identity and authority services |
| Invitation capability | Explicit header security declaration | Exact 43-character base64url capability | Recruitment Service |
| File upload | Multipart schema plus existing strict field/file checks | JPEG, PNG, or PDF; non-empty; configured byte bound | Receipt file store, Economy transaction, outbox |
| OpenAPI artifact | Projection from `NativeApi` | Deterministic serialization and `--check` byte comparison | `packages/http-api` generator |
| Internal evidence | Internal HttpApi group | E2E mode and owner session | Economy evidence query; excluded from OpenAPI |
| Better Auth | External Request -> Response handler | Better Auth owns its wildcard and response contract | `AuthEngine`; never declared as NativeApi-owned |

Canonical truth is the in-memory `NativeApi` declaration. OpenAPI, reflection inventories, and any
later documentation are projections. They cannot introduce routes or schemas.

## Process and resource graph

The composition root retains one `ManagedRuntime` and one resource graph. It owns `DatabaseLive`,
Admissions, Economy, Organization, Profile, Schools, Recruitment, ContentManagement, Content,
Better Auth/Identity, native HttpApi handlers, the HTTP router, and the public application outbox
worker. No request constructs a `Layer`, `ManagedRuntime`, file store, authentication engine, or
database pool.

Startup still proves `databaseHealth` before listening. Shutdown still stops accepting/active HTTP,
interrupts the outbox worker, disposes the one runtime, and exits once. Better Auth uses the exact
same Layer-scoped engine as `Identity`.

Add exact `@effect/platform-bun@4.0.0-rc.109` to the root `effect-v4` catalog and backend. Do not add
the nonexistent base `@effect/platform`. Do not change the separate infra/Alchemy beta.103 graph.
`@effect/openapi-generator` is reverse OpenAPI-to-Effect tooling and is not part of this design.

## Canonical route, authority, and effect table

Classification totals are public 14 (including health), authenticated 7, admin 26, and internal 1.
Unless stated otherwise, JSON responses retain `application/json; charset=utf-8` and
`cache-control: no-store`. Organization responses retain their CORS headers. OpenAPI operation IDs
are the endpoint identifiers shown below and must be unique.

| # | Operation ID | Method and path | Authority | Runtime request schema and compatibility rule | Success contract | Effect/service |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `listDepartments` | GET `/api/departments` | Public | Empty query | 200 `DepartmentJson[]` | `Organization.listDepartments` |
| 2 | `listTeams` | GET `/api/teams` | Public | Empty query | 200 `TeamJson[]` | `Organization.listTeams` |
| 3 | `listFieldOfStudies` | GET `/api/field_of_studies` | Public | Empty query | 200 `FieldOfStudyJson[]` | `Organization.listFieldOfStudies` |
| 4 | `listTeamInterest` | GET `/api/admin/team-interest` | Active global administrator or active team-leader scope | Optional `department`, `semester`; current unknown/duplicate-key compatibility is retained | 200 strict Hydra member/total envelope | `Organization.listTeamInterestRegistrations` |
| 5 | `listMailingLists` | GET `/api/admin/mailing-lists` | Same leader/global scope as row 4 | Optional `type=assistants\|team\|all`, `department`, `semester`; current ignored extra/duplicate compatibility retained | 200 `{name,emails[]}[]` | `Organization.projectMailingLists` |
| 6 | `createDepartment` | POST `/api/admin/departments` | Active global administrator | Empty query; bounded strict `CreateDepartmentCommandSchema` JSON | 201 committed or 200 replay `CreateDepartmentResultSchema` | `Organization.createDepartment` |
| 7 | `createTeam` | POST `/api/admin/teams` | Active global administrator | Empty query; bounded strict `CreateTeamCommandSchema` JSON | 201 committed or 200 replay `CreateTeamResultSchema` | `Organization.createTeam` |
| 8 | `createFieldOfStudy` | POST `/api/admin/field-of-studies` | Active global administrator | Empty query; bounded strict `CreateFieldOfStudyCommandSchema` JSON | 201 committed or 200 replay `CreateFieldOfStudyResultSchema` | `Organization.createFieldOfStudy` |
| 9 | `listAdminUsers` | GET `/api/admin/users` | Active global administrator or active leader department union | Query must be empty | 200 strict active/inactive directory projection with nullable cursor | `Profile.readDirectoryPage` + `Organization.deriveDirectoryFacts` |
| 10 | `listSchools` | GET `/api/admin/schools` | Active global administrator or active membership in scope | Empty query or exactly one `department` | 200 `SchoolDirectorySchema` | `readSchoolsDirectory` |
| 11 | `health` | GET `/health` | Public | Query is ignored | 200 `{status:"ok"}` or 503 `{status:"unavailable"}` | `databaseHealth` |
| 12 | `readSession` | GET `/api/me/session` | Better Auth session cookie | Query ignored | 200 `{personId,expiresAt}`; 401 invalid session; 503 engine failure | `Identity.resolveSession` |
| 13 | `readOwnProfile` | GET `/api/me` | Active in-scope session | Query ignored | 200 strict profile with role and revisions | `Profile.readOwnProfile` |
| 14 | `updateOwnProfile` | PUT `/api/me` | Same as row 13 | Strict `UpdateOwnProfileCommand`; current query compatibility retained | 200 strict profile projection | `Profile.updateOwnProfile` then read |
| 15 | `readInvitationResponse` | GET `/api/recruitment/invitation-response` | Invitation capability header | Empty query; exact capability header | 200 `RecruitmentInvitationResponseObservationSchema` | `Recruitment.readInvitationResponse` |
| 16 | `confirmInvitation` | POST `/api/recruitment/invitation-response/confirm` | Invitation capability header | Empty query; bounded strict empty JSON object | 204 empty, no-store | `Recruitment.confirmInvitation` |
| 17 | `rejectInvitation` | POST `/api/recruitment/invitation-response/reject` | Invitation capability header | Empty query; bounded strict reject schema | 204 empty, no-store | `Recruitment.rejectInvitation` |
| 18 | `requestNewInvitationTime` | POST `/api/recruitment/invitation-response/request-new-time` | Invitation capability header | Empty query; bounded strict new-time schema | 204 empty, no-store | `Recruitment.requestNewInvitationTime` |
| 19 | `readAssignmentBoard` | GET `/api/admin/recruitment/assignment-board` | Active single-department leader | Exactly one `status=new\|all` | 200 `RecruitmentAssignmentBoardSchema` | `Recruitment.readAssignmentBoard` |
| 20 | `readSchedulingBoard` | GET `/api/admin/recruitment/interviews/scheduling-board` | Active single-department member or leader | Empty query | 200 `RecruitmentSchedulingBoardSchema` | `Recruitment.readSchedulingBoard` |
| 21 | `assignApplicant` | POST `/api/admin/recruitment/interviews/assign` | Active single-department leader | Empty query; bounded strict `RecruitmentAssignmentCommandSchema` | 200 assignment result with replay flag | `Recruitment.assignApplicant` |
| 22 | `scheduleInterview` | POST `/api/admin/recruitment/interviews/schedule` | Active assigned member or leader | Empty query; bounded strict `RecruitmentScheduleCommandSchema` | 200 schedule result with replay flag | `Recruitment.scheduleInterview` |
| 23 | `readInterviewConduct` | GET `/api/admin/recruitment/interviews/:interviewId/conduct` | Active assigned interviewer in actual interview department | Strict branded path ID; empty query | 200 `RecruitmentInterviewConductObservationSchema` | `Recruitment.readInterviewConduct` |
| 24 | `finalizeInterview` | POST `/api/admin/recruitment/interviews/:interviewId/finalize` | Same as row 23 | Empty query; bounded strict finalize command; body/path IDs equal | 200 `FinalizeInterviewResultSchema` | `Recruitment.finalizeInterview` |
| 25 | `cancelInterview` | POST `/api/admin/recruitment/interviews/:interviewId/cancel` | Same as row 23 | Empty query; bounded strict cancel command; body/path IDs equal | 200 `CancelInterviewResultSchema` | `Recruitment.cancelInterview` |
| 26 | `listOpenAdmissionPeriods` | GET `/api/admission-periods/open` | Public | Empty query | 200 admission-period item/total envelope | `Admissions.listOpenAdmissionPeriods` |
| 27 | `readApplicationCatalog` | GET `/api/applications/catalog` | Public | Empty query | 200 `PublicApplicationCatalogSchema` | `Admissions.listPublicApplicationCatalog` |
| 28 | `submitApplication` | POST `/api/applications` | Public shared rate-limit boundary | Empty query; bounded strict `PublicApplicationSubmitInputSchema` | 201 submitted or 200 replay observation | `Admissions.executePublicApplication` |
| 29 | `readApplicationConfirmation` | GET `/api/applications/:applicationId/confirmation` | Public | One decoded path segment; empty query | 200 `PublicApplicationConfirmationSchema` | `Admissions.findPublicApplicationConfirmation` |
| 30 | `listAdmissionPeriods` | GET `/api/admin/admission-periods` | Active global administrator | Empty query | 200 management item/total envelope | `Admissions.listAdmissionPeriodsForManagement` |
| 31 | `createAdmissionPeriod` | POST `/api/admin/admission-periods` | Active global administrator | Empty query; bounded strict create payload | 201 committed or 200 replay observation | `Admissions.executeAdmissionPeriod` |
| 32 | `reviseAdmissionPeriod` | POST `/api/admin/admission-periods/:admissionPeriodId/revise` | Active global administrator | Decoded path; empty query; bounded strict revise payload | 200 observation including replay | `Admissions.executeAdmissionPeriod` |
| 33 | `submitReceipt` | POST `/api/receipts/submit` | Session principal and Economy payment authority | At most one nonempty `departmentId`; exact multipart fields and bounded JPEG/PNG/PDF file | 201 pending observation or 200 replay | File store + `Economy.executeReceipt` + outbox drain |
| 34 | `reviseReceipt` | POST `/api/receipts/:receiptId/revise` | Receipt owner session principal | Decoded path; exact multipart required fields and optional bounded file; current query compatibility retained | 200 `ReceiptObservationSchema` | File store + `Economy.executeReceipt` + outbox drain |
| 35 | `withdrawReceipt` | POST `/api/receipts/:receiptId/withdraw` | Receipt owner session principal | Decoded path; exact strict command JSON; current query compatibility retained | 200 withdrawn `ReceiptObservationSchema` | `Economy.executeReceipt` + outbox drain |
| 36 | `listReceipts` | GET `/api/receipts` | Owner session | Optional valid `status`; current first-value/ignored-extra compatibility retained | 200 owner item/total projection | `Economy.listOwnedReceipts` |
| 37 | `listReceiptsForApproval` | GET `/api/admin/receipts` | Session principal plus Economy approval authority | At most one valid `status`; no other query keys | 200 approval item/total projection | `Economy.listReceiptsForApproval` |
| 38 | `refundReceipt` | POST `/api/admin/receipts/:receiptId/refund` | Economy approval authority | Decoded path; empty query; exact strict command JSON | 200 refunded `ReceiptObservationSchema` | `Economy.executeReceipt` + outbox drain |
| 39 | `rejectReceipt` | POST `/api/admin/receipts/:receiptId/reject` | Economy approval authority | Decoded path; empty query; exact strict command JSON | 200 rejected `ReceiptObservationSchema` | `Economy.executeReceipt` + outbox drain |
| 40 | `readReceiptEvidence` | GET `/api/e2e/receipts/:receiptId/evidence` | E2E mode plus owner session | Decoded path; current query compatibility retained | 200 strict lifecycle file/outbox/audit evidence | `Economy.readReceiptLifecycleEvidence`; internal group, excluded from OpenAPI |
| 41 | `readContentWorkspace` | GET `/api/admin/content/workspace` | Session and ContentManagement scope | At most one `department`; no other keys | 200 `ContentWorkspaceSchema`; current cache header behavior retained | `runContentWorkspace` |
| 42 | `createArticle` | POST `/api/admin/content/articles` | ContentManagement create authority | Strict create JSON; retain current content-type/body-size behavior | 201 `ArticleDraft.json`; no-store | `runPublicationTransition(CreateDraft)` |
| 43 | `readArticle` | GET `/api/admin/content/articles/:articleId` | ContentManagement read scope | Positive integer path; empty query | 200 `ContentArticleDetailSchema`; no-store | `runContentArticleDetail` |
| 44 | `reviseArticle` | PUT `/api/admin/content/articles/:articleId` | Draft ownership/revise authority | Positive path; strict revise JSON; body/path IDs equal; current query compatibility retained | 200 `ArticleDraft.json`; no-store | `runPublicationTransition(ReviseDraft)` |
| 45 | `publishArticle` | POST `/api/admin/content/articles/:articleId/publish` | Publisher authority | Positive path; strict publish JSON; body/path IDs equal; current query compatibility retained | 200 `PublishObservationSchema`; no-store | `runPublicationTransition(Publish)` |
| 46 | `unpublishArticle` | POST `/api/admin/content/articles/:articleId/unpublish` | Publisher authority | Positive path; strict unpublish JSON; body/path IDs equal; current query compatibility retained | 200 `UnpublishObservationSchema`; no-store | `runPublicationTransition(Unpublish)` |
| 47 | `listNews` | GET `/api/news` | Public | At most one `department`; no other keys | 200 `PublishedNewsListingSchema`; no-store | `readPublicNews(Listing)` |
| 48 | `readNewsArticle` | GET `/api/news/:slug` | Public | Decoded slug; optional single positive integer `version`; no other keys | 200 `PublishedNewsArticleSchema`; no-store | `readPublicNews(Article)` |

## Error contracts

Errors remain JSON `{error:{tag}}`, except the two receipt composed-denial tags retain their stable
`message`. The contract defines status-specific runtime schemas, not untyped `unknown` fallbacks.

| Group | Status mapping |
| --- | --- |
| Organization | 401 unauthenticated; 403 role; 409 command conflict; 413 body too large; 422 invalid reference/decode; 503 persistence/unknown |
| Admin users | 401 unauthenticated; 403 inactive/out of scope; 422 malformed cursor/query; 503 provider/decode/persistence |
| Schools | 401 unauthenticated; 403 inactive/out of scope; 422 input query/department; 503 domain decode/persistence |
| Profile | 401 unauthenticated; 403 inactive/out of scope; 404 profile/contact; 409 stale/command conflict; 422 decode; 503 persistence |
| Admission | 401 unauthenticated; 403 inactive/role/scope; 404 department/period/application; 409 eligibility/duplicate/stale conflicts; 413 body too large; 422 input/window/reference; 429 public rate limit; 503 all unlisted/provider failures |
| Recruitment | 401 unauthenticated; 403 inactive/role/scope/interviewer; 404 referenced entities/capability; 409 lifecycle/replay conflicts; 413 body too large; 422 decode/schema/schedule/conduct validation; 503 contact/questions/persistence/unknown |
| Receipt | 401 unauthenticated; 403 owner/scope/authority/composed denial; 404 receipt; 409 duplicate/stale/transition; 422 decode/file staging; 503 persistence/unknown |
| Content | 401 unauthenticated; 403 inactive/scope/publisher/ownership; 404 article; 409 command conflict; 422 decode/slug/department; 503 integrity/persistence/unknown |
| Health/session | Health collapses all failures to unavailable/503. Session uses 401 `UnauthenticatedActor` and 503 `IdentityEngineError`. |

## Router cutover

1. Declare all 48 routes in per-group `packages/http-api/src/*.ts` files and combine them in
   `NativeApi`.
2. Implement every group with `HttpApiBuilder.group(...).handleAll(...)` or one typed `handle` per
   endpoint. Builder completeness must fail at compile time when an endpoint has no handler.
3. Remove the broad predicates and Vektor route dispatch from `apps/backend/src/router.ts`.
4. Remove each manual method/path `if`/regex dispatch from the domain `http.ts` adapters. Helpers may
   remain only when they implement decoding, error translation, and transport behavior for exactly
   one named handler; they cannot retain route authority.
5. Keep only explicit Better Auth `/api/auth/*` external fallback, CORS/OPTIONS transport handling,
   and native router fallback. The contract router must run before no fallback except Better Auth.
6. The native 404 remains `{error:{tag:"RouteNotFound"}}`. Wrong methods remain unmapped rather than
   reaching a domain handler.

No Vektor-owned method/path literal can exist in two server authorities after its group cutover.
Tests and clients may contain request literals; server dispatch may not.

## Contract documentation and generated OpenAPI

Every exported contract declaration has pragmatic doc comments with `@since 0.1.0`, a meaningful
`@category`, and a description. Important commands and response projections include schema examples
where they improve the generated contract. The package is ready for later `@effect/docgen` without
adding docgen now or contaminating the TypeScript 7 root with incompatible peers.

The generator:

1. calls `OpenApi.fromApi(NativeApi)`;
2. asserts OpenAPI `3.1.0`, 47 operations, unique operation IDs, no `/api/auth/*`, no internal E2E
   path, no production server, and representative public/session/admin/multipart/error schemas;
3. serializes deterministically with a trailing newline;
4. writes `packages/http-api/openapi.json`, or compares exact bytes under `--check`.

Reflection tests derive their inventory from `NativeApi`; there is no second handwritten route list.
They prove 48 unique method/path pairs, all endpoint handlers present, unique operation IDs, and the
single internal exclusion.

## Compatibility obligations

- Preserve exact observable statuses, bodies, headers, authentication points, query acceptance, and
  error tags above. Tightening a currently ignored query key without an explicit contract test is a
  behavior regression, not cleanup.
- Keep schema decoding strict for every existing strict body/query boundary. HttpApi automatic
  decoding cannot turn a 422 domain-specific error into an unrelated default response.
- Preserve receipt content-length and multipart field rules, staging cleanup, replay cleanup,
  promotion/outbox drain, composed authority, and no-store responses.
- Preserve one captured authorization instant for each authenticated request.
- Preserve E2E evidence execution when explicitly enabled while excluding it from public OpenAPI.
- Do not expose Better Auth as a native contract-owned operation.

## Verification

Focused verification must cover package and backend types, lint, tests, and generated drift. Existing
HTTP behavior tests migrate to the contract-bound handler. Counterexamples remain: unknown query
keys where rejected, excess JSON fields, missing/invalid session, inactive/out-of-scope actors,
body/path mismatch, stale revision/conflict, malformed multipart/file, capability rejection,
provider/persistence failure, wrong method, and unmapped path.

A disposable PostgreSQL smoke run exercises health, departments, Better Auth session, one authorized
command, one denial, receipt multipart and read-back, recruitment, content/news, and an unmapped 404.
It must not use production/shared preview state, providers, or credentials.

Final root checks run sequentially: format/check, lint, build, and test. Commits use pathspecs and
coherent group cutovers. The worktree is clean at delivery.

## Falsifiers

This implementation fails the spec if any of these are true:

- a declared endpoint has no live handler, or a live Vektor route is absent from `NativeApi`;
- a Vektor-owned method/path has two server-side authorities or a manual fallback wins;
- an OpenAPI operation is absent, has the wrong method/path/status/schema, or has a duplicate ID;
- Better Auth or the internal evidence route appears in public OpenAPI;
- generated OpenAPI bytes are hand-maintained or `--check` accepts drift;
- request excess-property/query validation becomes weaker than the frozen table;
- receipt multipart, file lifecycle, composed authority, or outbox behavior changes;
- any request constructs a Layer/runtime/resource graph;
- process startup/shutdown no longer owns exactly one runtime and one Better Auth engine;
- the root acquires a nonexistent `@effect/platform`, reverse generator tooling, or infra beta.103
  changes;
- a placeholder, fake schema, stub handler, no-op authority, compatibility shim, or partial API is
  presented as complete.

## Acceptance

1. This frozen spec is committed before implementation.
2. `packages/http-api` is the canonical complete 48-endpoint contract with 47 documented operations
   and one internal excluded operation.
3. All 48 endpoints have live HttpApiBuilder handlers; manual Vektor dispatch is removed.
4. Better Auth remains the only explicit external wildcard fallback.
5. Generated `openapi.json` and `--check` pass with representative contract assertions.
6. Existing and added reflection/behavior tests pass, the disposable PostgreSQL smoke passes, and
   root format/check/lint/build/test pass sequentially.
7. All work is committed and the feature worktree is clean.
