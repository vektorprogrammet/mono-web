# RPC only

Status: in progress (2026-09-28), on branch `refactor/rpc-only`, cut from `6979637`
(`refactor/authz-evidence-organization`). The operator decided to delete the HttpApi contract, the
generated SDK, and OpenAPI, and to serve every native operation as an Effect RPC.

Remove this specification when every operation below is ported or recorded as dropped, the
journeys pass, and `docs/architecture.md`, `docs/system.md`, and `AGENTS.md` describe RPC.

## What stays HTTP

- Better Auth `/api/auth/*` and the OAuth2 routes: HTTP by protocol.
- `GET /health`: infrastructure probes it. `router.ts` serves it without RPC.
- The ingress in `apps/backend/src/router.ts`: trusted origins, CORS, and the OAuth gatekeeping
  wrap the RPC endpoint exactly as they wrapped the HttpApi routes.

## The HTTP contract to port

The deleted files are at the base commit. Read them with
`git show 6979637:<path>`: the contract in `packages/http-api/src/<context>.ts`, the handlers in
`apps/backend/src/<context>/http*.ts`, the endpoint tests in `*.http.test.ts` and `*/http.test.ts`,
the backend harness `apps/backend/src/test/native-http.ts`, and the SDK in `packages/sdk`.
Port the behavior; do not rewrite it from memory.

## Conventions

The precedent is social events, ported end to end: the contract
`packages/rpc/src/social-events.ts`, the handlers `apps/backend/src/social-events/rpc.ts`, and the
dashboard bridge `apps/dashboard/app/routes/__foldkit.social-events.ts`. Copy its shape.

- **Tag.** The RPC tag is the old operation ID (`social-events.create`). Command receipts store it.
- **Payload.** Path, query, and body fields become one payload struct. A replayable command takes
  `idempotencyKey: IdempotencyKey`; the old body is its `request` field. An If-Match precondition
  becomes `ifMatch: StrongETag`, compared inside the committing transaction as before.
- **ETags.** A success that carried an ETag header that a later RPC takes as `ifMatch` returns it
  as a field beside the resource. Derive it exactly as the handler did.
- **Conditional reads.** `If-None-Match` and 304 are dropped. Record each in the checklist.
- **Errors.** Each RPC declares `error: rpcProblems(<Operation>Problem)`. Drop the codes that only
  HTTP parsing produced: `request.malformed`, `header.malformed`, `origin.denied`,
  `request.too-large`, `media-type.unsupported`, `idempotency-key.invalid`,
  `precondition.required`, `method.not-allowed`. Keep `credential.missing` and
  `credential.invalid` when the handler re-resolves the credential in its transaction.
  `packages/rpc/src/endpoint-problems.ts` still holds the old unions to start from.
- **Structural validation.** A payload that does not decode fails in the RPC server before the
  handler, not as `validation.failed` with pointers. Semantic validation stays `validation.failed`.
  Record each UI that showed field errors from schema decoding.
- **Credentials.** The RPC takes the middleware of its old security: `PersonCredential`,
  `SessionCredential`, `PersonOrServiceCredential`, `InvitationCapabilityCredential` (the
  capability moves into the payload), or `ContactBackendCredential`. The handler still resolves the
  credential and the authority inside its transaction, from the `headers` its options carry,
  through `credentialRequestOf(headers)`.
- **AccessSpec.** `.pipe(withAccessSpec(...))` on the RPC; the handler evaluates it with
  `authorizePerson(..., personPresentation(headers))` and `reflectAccessSpec(<Rpc>)`.
- **Command receipts.** `executeNativeHttpCommandPostgres` stays. `execute` ends with
  `successCapsule(<SuccessSchema>)`, and the handler answers `commandOutcome(<SuccessSchema>)`.
  `commandIdentity` takes the old HTTP route path as `normalizedTarget`, so receipts and domain
  command IDs of commands that straddle the cutover stay stable.
- **Defects.** Every RPC runs inside `ProblemBoundary`: a defect is reported and answered
  `internal.error`. Do not catch defects in a handler.
- **Handlers.** Each context exports `<Group>RpcHandlers(options: NativeRpcOptions)` from its
  `rpc.ts`. `router.ts` already lists every one; do not edit it.
- **Re-exports.** A contract re-exports only the schemas its own RPCs use. Clients import other
  domain values from `@vektorprogrammet/domain`.
- **Clients.** The dashboard server calls `callNative(cookie, request, (client) => ...)` from
  `apps/dashboard/app/lib/api.server.ts`. Journey drivers and probes use `makeScriptClient` from
  `@vektorprogrammet/rpc/script`, whose results keep the registry status of each problem. Backend
  tests use `makeBackendTestRpc` from `apps/backend/src/test/native-rpc.ts`.
- **Files.** Uploads and downloads travel as bytes in the payload (`Schema.Uint8Array`) on the JSON
  endpoint, where the dashboard server relays them. If a browser needs a direct URL, or JSON size
  is a problem, record it; `RpcSerialization.layerSchemaBinary` exists and would need its own path.

## Effect lookup order

Before writing Effect code, read in this order, and check every API against the installed source:

1. `node_modules/effect/AGENTS.md` and the `ai-docs` examples it links.
2. `.agents/skills/effect-house/SKILL.md` and its `references/`.
3. The official repository at the installed release, outside this repository:
   `/home/claude/reference/effect-4.0.0-rc.116` (`LLMS.md`, and for RPC
   `packages/effect/test/rpc/*.test.ts`). It is a reference, not a dependency.
4. The installed source under `node_modules/effect/src` is the authority.

## Missing capabilities

Record here every behavior of the HTTP contract that RPC does not provide, with the operation and
what a client loses.

- `If-None-Match` and 304 on 13 reads: a client re-reads the full resource.
- OpenAPI: third-party OAuth clients (82 operations accept an OAuth user bearer) lose a
  machine-readable contract and must speak the Effect RPC wire protocol.

## Checklist

Mark an operation `ported` when its RPC, handler, client callers, and tests exist, or `dropped`
with the reason in Missing capabilities.

### admissionOutcomes (`packages/rpc/src/admission-outcomes.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `admissionOutcomes.listScopes` | GET `/api/admission-outcomes/scopes` | - | cookieHeader, oauthUserBearer | todo |
| `admissionOutcomes.readOutcome` | GET `/api/admission-outcomes/{applicationId}` | ifMatch; if-none-match (dropped) | cookieHeader, oauthUserBearer | todo |
| `admissionOutcomes.readOutcomes` | GET `/api/admission-outcomes` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `admissionOutcomes.recordOutcome` | POST `/api/admission-outcomes/{applicationId}:record` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |

### admissions (`packages/rpc/src/admissions.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `admissions.createAdmissionPeriod` | POST `/api/admission-periods` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `admissions.listAdmissionPeriods` | GET `/api/admission-periods` | ifMatch; if-none-match (dropped) | cookieHeader, oauthUserBearer | todo |
| `admissions.listApplicationOptions` | GET `/api/application-options` | ifMatch; if-none-match (dropped) | none | todo |
| `admissions.listOpenAdmissionPeriods` | GET `/api/open-admission-periods` | ifMatch; if-none-match (dropped) | none | todo |
| `admissions.readApplicantProgress` | GET `/api/applicant-progress` | - | cookieHeader, oauthUserBearer | todo |
| `admissions.readApplicationConfirmation` | GET `/api/applications/{applicationId}` | - | none | todo |
| `admissions.readReturningAssistantOptions` | GET `/api/returning-assistant/options` | - | cookieHeader, oauthUserBearer | todo |
| `admissions.registerReturningAssistant` | POST `/api/returning-assistant/registrations` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `admissions.reviseAdmissionPeriod` | PATCH `/api/admission-periods/{admissionPeriodId}` | idempotencyKey; ifMatch; merge patch | cookieHeader, oauthUserBearer | todo |
| `admissions.submitApplication` | POST `/api/applications` | idempotencyKey | none | todo |

### certificates (`packages/rpc/src/certificates.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `certificates.confirmDaysServed` | POST `/api/departments/{departmentId}/semesters/{semesterId}/days-served/{personId}` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `certificates.issueCertificate` | POST `/api/departments/{departmentId}/certificates/{personId}/issues` | idempotencyKey; ifMatch; binary application/pdf | cookieHeader, oauthUserBearer | todo |
| `certificates.listCertificates` | GET `/api/departments/{departmentId}/certificates` | query: cursor | cookieHeader, oauthUserBearer | todo |
| `certificates.listDaysServed` | GET `/api/departments/{departmentId}/semesters/{semesterId}/days-served` | query: cursor | cookieHeader, oauthUserBearer | todo |
| `certificates.readCertificate` | GET `/api/departments/{departmentId}/certificates/{personId}` | - | cookieHeader, oauthUserBearer | todo |
| `certificates.readCertificateScopes` | GET `/api/certificate-scopes` | - | cookieHeader, oauthUserBearer | todo |

### contact (`packages/rpc/src/contact.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `contact.submitContactMessage` | POST `/api/contact-messages` | contact ip header | contactBackend | todo |

### content (`packages/rpc/src/content.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `content.createArticle` | POST `/api/content/articles` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `content.listNews` | GET `/api/news` | ifMatch; if-none-match (dropped); query: department | none | todo |
| `content.publishArticle` | POST `/api/content/articles/{articleId}:publish` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `content.readArticle` | GET `/api/content/articles/{articleId}` | ifMatch; if-none-match (dropped) | cookieHeader, oauthUserBearer | todo |
| `content.readContentWorkspace` | GET `/api/content/articles` | query: department | cookieHeader, oauthUserBearer | todo |
| `content.readNewsArticle` | GET `/api/news/{slug}` | ifMatch; if-none-match (dropped); query: version | none | todo |
| `content.reviseArticle` | PATCH `/api/content/articles/{articleId}` | idempotencyKey; ifMatch; merge patch | cookieHeader, oauthUserBearer | todo |
| `content.unpublishArticle` | POST `/api/content/articles/{articleId}:unpublish` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |

### directory (`packages/rpc/src/directory.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `directory.executeSchoolCommand` | POST `/api/schools/commands` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `directory.listPeople` | GET `/api/people` | - | cookieHeader, oauthUserBearer | todo |
| `directory.listSchools` | GET `/api/schools` | query: department | cookieHeader, oauthUserBearer | todo |
| `directory.readSchoolManagement` | GET `/api/schools/management` | - | cookieHeader, oauthUserBearer | todo |

### internal (`packages/rpc/src/receipts.ts (InternalReceiptsRpcs)`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `receipts.readReceiptEvidence` | GET `/api/receipt-lifecycle-evidence-records/{receiptId}` | - | cookieHeader | todo |

### onboarding (`packages/rpc/src/onboarding.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `onboarding.claim` | POST `/api/onboarding/claim` | - | cookieHeader | todo |
| `onboarding.command` | POST `/api/onboarding` | idempotencyKey; ifMatch; query: departmentId | cookieHeader, oauthUserBearer | todo |
| `onboarding.readBoard` | GET `/api/onboarding` | query: departmentId | cookieHeader, oauthUserBearer | todo |

### organization (`packages/rpc/src/organization.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `organization.createDepartment` | POST `/api/departments` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `organization.createFieldOfStudy` | POST `/api/field-of-studies` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `organization.createTeam` | POST `/api/teams` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `organization.executeDelegation` | POST `/api/organization/delegations/commands` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `organization.executeLifecycle` | POST `/api/organization/appointments/commands` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `organization.listDepartments` | GET `/api/departments` | ifMatch; if-none-match (dropped) | none | todo |
| `organization.listFieldOfStudies` | GET `/api/field-of-studies` | ifMatch; if-none-match (dropped) | none | todo |
| `organization.listMailingLists` | GET `/api/mailing-lists` | query: department, semester, type | cookieHeader, oauthUserBearer | todo |
| `organization.listTeamInterest` | GET `/api/team-interest-registrations` | query: department, semester | cookieHeader, oauthUserBearer | todo |
| `organization.listTeams` | GET `/api/teams` | ifMatch; if-none-match (dropped) | none | todo |
| `organization.readAppointmentManagement` | GET `/api/organization/appointments` | - | cookieHeader, oauthUserBearer | todo |
| `organization.readBoardRosters` | GET `/api/organization/board-rosters` | - | cookieHeader, oauthUserBearer | todo |
| `organization.readDelegationManagement` | GET `/api/organization/delegations` | - | cookieHeader, oauthUserBearer | todo |

### placements (`packages/rpc/src/placements.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `placements.commandBoard` | POST `/api/placements` | idempotencyKey; ifMatch; query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.commandCoverageBoard` | POST `/api/placements/coverage` | idempotencyKey; ifMatch; query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.commandOwnAffiliation` | POST `/api/placements/affiliation` | idempotencyKey; ifMatch; query: departmentId | cookieHeader, oauthUserBearer | todo |
| `placements.commandOwnCoverage` | POST `/api/placements/coverage/own` | idempotencyKey; ifMatch; query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.listScopes` | GET `/api/placements/scopes` | - | cookieHeader, oauthUserBearer | todo |
| `placements.readBoard` | GET `/api/placements` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.readCoverageBoard` | GET `/api/placements/coverage` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.readDraft` | GET `/api/placements/draft` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |
| `placements.readOwnAffiliation` | GET `/api/placements/affiliation` | query: departmentId | cookieHeader, oauthUserBearer | todo |
| `placements.readOwnCoverage` | GET `/api/placements/coverage/own` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | todo |

### profile (`packages/rpc/src/profile.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `profile.readOwnProfile` | GET `/api/profile` | ifMatch; if-none-match (dropped) | cookieHeader, oauthUserBearer | todo |
| `profile.updateOwnProfile` | PATCH `/api/profile` | idempotencyKey; ifMatch; merge patch | cookieHeader, oauthUserBearer | todo |

### receipts (`packages/rpc/src/receipts.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `receipts.approveReceipt` | POST `/api/receipts/{receiptId}:approve` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `receipts.listReceipts` | GET `/api/receipts` | query: cursor, status | cookieHeader, oauthUserBearer | todo |
| `receipts.listReceiptsForApproval` | GET `/api/receipt-approval-queue` | query: cursor, status | cookieHeader, oauthUserBearer, oauthServiceBearer | todo |
| `receipts.listReceiptsForSettlement` | GET `/api/receipt-settlement-queue` | query: cursor | cookieHeader, oauthUserBearer | todo |
| `receipts.readReceiptFile` | GET `/api/receipts/{receiptId}/file` | binary application/octet-stream | cookieHeader, oauthUserBearer | todo |
| `receipts.readReceiptFileForApproval` | GET `/api/receipt-approval-queue/{receiptId}/file` | binary application/octet-stream | cookieHeader, oauthUserBearer | todo |
| `receipts.readReceiptSettlementForFinance` | GET `/api/receipt-settlement-queue/{receiptId}` | - | cookieHeader, oauthUserBearer | todo |
| `receipts.rejectReceipt` | POST `/api/receipts/{receiptId}:reject` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `receipts.reopenReceipt` | POST `/api/receipts/{receiptId}:reopen` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `receipts.reviseReceipt` | PATCH `/api/receipts/{receiptId}` | idempotencyKey; ifMatch; multipart upload | cookieHeader, oauthUserBearer | todo |
| `receipts.settleReceipt` | POST `/api/receipts/{receiptId}:settle` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `receipts.submitReceipt` | POST `/api/receipts` | idempotencyKey; multipart upload; query: departmentId | cookieHeader, oauthUserBearer | todo |
| `receipts.withdrawReceipt` | POST `/api/receipts/{receiptId}:withdraw` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |

### recruitment (`packages/rpc/src/recruitment.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `recruitment.cancelInterview` | POST `/api/recruitment/interviews/{interviewId}:cancel` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `recruitment.confirmInvitation` | POST `/api/recruitment/invitation-response:confirm` | ifMatch | invitationCapability | todo |
| `recruitment.correctInterviewAssessment` | POST `/api/recruitment/interviews/{interviewId}:correct` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `recruitment.createApplicationInterview` | POST `/api/recruitment/applications/{applicationId}/interviews` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `recruitment.finalizeInterview` | POST `/api/recruitment/interviews/{interviewId}:finalize` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |
| `recruitment.maintainRecruitment` | POST `/api/recruitment/maintenance/commands` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `recruitment.readAssignmentBoard` | GET `/api/recruitment/application-assignments` | query: status | cookieHeader, oauthUserBearer | todo |
| `recruitment.readInterviewConduct` | GET `/api/recruitment/interviews/{interviewId}` | ifMatch; if-none-match (dropped) | cookieHeader, oauthUserBearer | todo |
| `recruitment.readInterviewReport` | GET `/api/recruitment/interview-report` | query: admissionPeriodId, recommendation, participation, sort, direction | cookieHeader, oauthUserBearer | todo |
| `recruitment.readInterviewStaffing` | GET `/api/recruitment/interview-staffing` | - | cookieHeader, oauthUserBearer | todo |
| `recruitment.readInvitationResponse` | GET `/api/recruitment/invitation-response` | ifMatch; if-none-match (dropped) | invitationCapability | todo |
| `recruitment.readQuestionnaires` | GET `/api/recruitment/questionnaires` | - | cookieHeader, oauthUserBearer | todo |
| `recruitment.readSchedulingBoard` | GET `/api/recruitment/interviews` | - | cookieHeader, oauthUserBearer | todo |
| `recruitment.rejectInvitation` | POST `/api/recruitment/invitation-response:reject` | ifMatch | invitationCapability | todo |
| `recruitment.requestNewInvitationTime` | POST `/api/recruitment/invitation-response:request-new-time` | ifMatch | invitationCapability | todo |
| `recruitment.scheduleInterview` | POST `/api/recruitment/interviews/{interviewId}:schedule` | idempotencyKey; ifMatch | cookieHeader, oauthUserBearer | todo |

### social-events (`packages/rpc/src/social-events.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `social-events.create` | POST `/api/social-events` | idempotencyKey | cookieHeader, oauthUserBearer | ported |
| `social-events.list` | GET `/api/social-events` | query: departmentId, semesterId | cookieHeader, oauthUserBearer | ported |
| `social-events.readScope` | GET `/api/social-events/scope` | - | cookieHeader, oauthUserBearer | ported |

### system (`packages/rpc/src/system.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `system.deleteOwnedSession` | DELETE `/api/sessions/{sessionId}` | idempotencyKey | cookieHeader | todo |
| `system.deleteSession` | DELETE `/api/session` | idempotencyKey | cookieHeader | todo |
| `system.health` | GET `/health` | - | none | todo |
| `system.listSessions` | GET `/api/sessions` | - | cookieHeader | todo |
| `system.readSession` | GET `/api/session` | - | cookieHeader | todo |
| `system.revokeAllSessions` | POST `/api/sessions:revoke-all` | idempotencyKey | cookieHeader | todo |
| `system.revokeOtherSessions` | POST `/api/sessions:revoke-others` | idempotencyKey | cookieHeader | todo |

### team-applications (`packages/rpc/src/team-application.ts`)

| RPC tag | Replaces | Transport facts | Credentials | Status |
| --- | --- | --- | --- | --- |
| `team-applications.deleteTeamApplication` | DELETE `/api/team-applications/{applicationId}` | idempotencyKey | cookieHeader, oauthUserBearer | todo |
| `team-applications.listTeamApplicationIntakes` | GET `/api/team-application-intakes` | - | none | todo |
| `team-applications.listTeamApplications` | GET `/api/teams/{teamId}/applications` | query: cursor | cookieHeader, oauthUserBearer | todo |
| `team-applications.readTeamApplication` | GET `/api/team-applications/{applicationId}` | - | cookieHeader, oauthUserBearer | todo |
| `team-applications.readTeamApplicationIntake` | GET `/api/teams/{teamId}/application-intake` | - | none | todo |
| `team-applications.reviseTeamApplicationIntake` | PATCH `/api/teams/{teamId}/application-intake` | idempotencyKey; ifMatch; merge patch | cookieHeader, oauthUserBearer | todo |
| `team-applications.submitTeamApplication` | POST `/api/teams/{teamId}/applications` | idempotencyKey | none | todo |
