# Certificates and days served

Status: frozen for implementation on 2026-09-26 (operator decisions below). Remove this specification when `docs/system.md`, the code, and the checks below represent it.

## Goal

At semester end, school coordination confirms how many days each assistant served in a department and semester.
An authorized issuer produces one certificate per assistant that lists every confirmed semester of service in the issuer's department, with school and days.
The board rosters show the derived seats that team leadership gives, so the set of issuers is visible, without storing copies of those seats.

This slice replaces the legacy certificate pages (`CertificateController`, `ProfileController::downloadCertificateAction`, `certificate/*.html.twig` in the Symfony repository) at the scope below. It fixes two legacy scope defects: any team leader could download a certificate for any user, and the certificate showed that user's history from every department.

## Operator decisions

- Certificates are in scope. Skolekoordinering records days served per assistant at semester end; Styret generates certificates for its department (`STATE.md`, operations scan).
- O8-16: Hovedstyret positions issue the certificates of a department that is not independent.
- 2026-09-26:
  - A day served is one distinct service date (Europe/Oslo) per person, department, and semester. Two blocks on one date, or covering several commitments on one date, count once.
  - Only two sources count: attendance recorded at completed dated service, and accepted legacy workday totals. A legacy total counts only when reconciled at import and is never expanded into dates. Placements, planned `workdays`, and attendance recorded on Unfulfilled outcomes and on standalone occurrences do not count.
  - The calculated count is a starting value. Each assistant's total for the semester, zero included, must be confirmed or adjusted before it can appear on a certificate. A later correction keeps the earlier confirmation as attributable history.
  - The certificate is cumulative, covering every confirmed semester in the issuer's department. It carries the issuer's name and the title of the seat that authorizes them, with no uploaded signature image. Every issue is recorded with who, when, and a hash of the content. Only issuers download it; the assistant does not.

## Lead decisions (conservative defaults; the operator may revise before the PR opens)

- Confirming days served is a department capability. Department reach holds it. The department grants it to its school-coordination team through the existing delegation mechanism, by explicit command; the system does not infer it from a team name.
- Issue happens on demand. There is no request or approval workflow.
- The board roster (Styret of an independent department, Hovedstyret) lists appointed and derived seats as of the request instant. Each derived seat shows its source leadership. The roster is visible to whoever can already read that board.
- Legacy certificates and signature images are not migrated. Their archive disposition belongs to cutover.
- Every name in the person record prints on a certificate. The PDF embeds a subsetted open-license font, such as Noto Sans under the OFL, with its provenance and license kept beside it. `certificate.unprintable` (422) is only for text that no embedded glyph covers, and a test covers it.
- The certificate-scope read declares the capabilities it serves: confirming days served or issuing certificates. Either one grants the read.
- The PDF response carries no file name, and the dashboard names the download.

## User journeys

1. A person holding the confirmation capability selects a department and semester. For each assistant they see the calculated count and the dated evidence behind it: dates, schools, and the accepted legacy total where present. They confirm or adjust each total, and the result reads back after reload. Changing one assistant's total leaves every other assistant and semester unchanged.
2. An issuer opens an assistant in the issuer's department and downloads a PDF. It states the assistant, the department, and every confirmed semester with school and days, and it carries the issuer's name, seat title, and the issue date. Semesters that are not confirmed are absent, and the page says so before download.
3. A member of Styret of an independent department issues only for that department, and so does a derived Styret seat. A member of Hovedstyret or a derived Hovedstyret seat issues for departments that are not independent. A global administrator issues for all departments. Everyone else is denied, including a team leader without a qualifying seat.
4. A board roster shows a team leader's derived seat while the leadership is current and drops it when the leadership ends. The seat grants no administration.

## Falsifiers (Done when these cannot happen)

- A placement or planned `workdays` adds a day without recorded attendance at completed dated service.
- One person, department, semester, and date counts more than once, or attendance on an Unfulfilled outcome or a standalone occurrence counts.
- A certificate includes an unconfirmed semester, another department's service, or a total other than the confirmed one.
- A confirmation or correction is not attributable, overwrites the earlier confirmation's history, or changes an attendance fact.
- An issue is not recorded, or two downloads of unchanged confirmed data produce different content hashes.
- An issuer outside the rules of journey 3 succeeds, or an eligible issuer is denied.
- A derived seat is stored as an appointment, outlives the leadership, or grants administration or global administration.
- The assistant can download their own certificate.

## Constraints

- Days served and certificates belong to Placements (`packages/domain/src/placements`, `packages/database/src/placements`). Authority and seats belong to Organization. Each context reads the other through its exported contracts.
- Confirmation and issue are commands with receipts, audit, and revision checks, following the existing command pattern. Authority is checked in the committing request.
- Collection reads are bounded, as in the reimbursement journey. The PDF is rendered on the server from the confirmed data.
- The dashboard `attester` route hosts the workflow. Dashboard workflow state stays in one Foldkit Model.
- The derived seat list is a projection computed from current leadership. It is not a table of seats.

## Non-goals

Changing placement or dated-service outcomes; inferring dates from placements; a certificate request queue; team-membership activity on certificates; assistant self-service; migrating legacy certificates; classifying which departments are independent (a production gate in `STATE.md`).

## Acceptance

A golden journey (`just` set, hosted CI) exercises journeys 1 to 4 against PostgreSQL. Its fault modes are a stale revision on confirmation, a revoked seat between page load and issue, and a database failure at commit, each followed by recovery in the same request. Every falsifier above has a test that fails when the rule breaks.

## Progress

Branch `feat/certificates-0926` (CertificatesBuild, then CertificatesBuild2, 2026-09-26), rebased on main 6740cbbc. Domain, persistence, database falsifier tests, the HTTP contract, and the backend handlers with the PDF are committed. The branch is not ready to merge: the backend HTTP tests (step 3) are missing, and `just check` has not run on this tip.

### Done

- Domain, `packages/domain`:
  - `authz/delegation.ts`: the delegable capability `placements.days-served` (board leaders and global administrators; `TeamArea`). The department grants it to Skolekoordinering by delegation.
  - `authz/reach.ts`: `certificateIssuerBasis` implements journey 3. An appointed seat comes first, then a derived seat, then the global-administrator grant. `derivedBoardSeats` projects current team leadership onto Styret or Hovedstyret. No reach reads a derived seat.
  - `organization/board-roster.ts`: `BoardRosters`, `CertificateIssuer`, and `issuerSeatTitle`.
  - `placements/days-served.ts`: distinct Oslo dates plus accepted legacy totals, the calculated count, the entry version (revision and evidence digest), the confirmation, the command, and name-keyed pages of 50.
  - `placements/certificate.ts`: the content (confirmed totals above zero, oldest first), the content hash, the preview with each semester's status, the issue, and the scopes.
  - `placements/certificate-failures.ts`: typed failures without HTTP status.
  - Service contracts: `Placements` gains `readCertificateScopes`, `readDaysServed`, `confirmDaysServed`, `listCertificates`, `readCertificate`, and `issueCertificate`. These resolve authority themselves in the caller's transaction. `Organization` gains `readBoardRosters`.
  - Tests that fail when a rule breaks: `authz/certificate-issuer.test.ts` (journey 3 matrix, derived seats end with leadership and give no administration), `placements/days-served.test.ts` (one count per date, legacy totals as totals, version), and `placements/certificate.test.ts` (confirmed semesters only, confirmed total, stable hash).
- Persistence, `packages/database`:
  - `migrations/0078-days-served-and-certificates.sql` (checksum recorded): the capability check, and `days_served_confirmations` (append-only, a trigger allows only the next revision). Also `certificate_issues` (append-only, `issued_by_person_id <> person_id`).
  - `placements/certificates.ts`: counted attendance is `Completed` decisions of dated commitments only. Unfulfilled outcomes, standalone occurrences, placements, and `workdays` never count. The assistants of a scope are those with counted attendance, an accepted legacy total, an active placement, or a confirmation. Commands take the department row lock, then the person lock and the `ForShare` authority.
  - `organization/authority-postgres.ts`: `readGovernedDepartmentsWithSql` and `certificateIssuerWithSql`. `organization/lifecycle-postgres.ts`: `readBoardRosters`, which has the visibility of appointment management. `PlacementsLive` and `OrganizationLive` wire them.
- Database falsifier tests, `packages/database/src/placements/certificates.test.ts` (6 tests on `DatabaseTestLive`): each item of the former step 1 has a case. Negative controls, each reverted, failed the suite: counting Unfulfilled outcomes, skipping the issue insert, dropping the own-certificate check, reading another department's confirmations, and keeping an ended leadership active.
- HTTP contract, `packages/http-api/src/certificates.ts` (group `certificates`, the six endpoints of the former step 2) and `GET /api/organization/board-rosters`. `placements.days-served` and `certificates.issue` are in `CAPABILITY_TYPES`; `certificate.empty` (409) and `certificate.unprintable` (422) are in the problem registry; `documentMutationResponse` in `http-semantics.ts` declares the PDF answer. `packages/http-api/test/native-api.test.ts` lists every operation. The generated OpenAPI and SDK artifacts are not tracked; `check-types` regenerates them.
- Backend, `apps/backend/src/placements/certificates-http.ts` (wired in `router.ts`, and `makeCertificatesTestHttp` in `src/test/native-http.ts`) and `readBoardRosters` in `organization/http.ts`. Commands run through `executeNativeHttpCommandPostgres` with `retry: "serialization-once"`. Before any replay, `prepare` calls the new `Placements.authorizeCertificateCommand`, which takes the command's department lock, person lock, and `ForShare` authority, so a revoked seat cannot replay a stored PDF. The entry tag derives from `daysServedEntryVersion`; the certificate tag, on the preview and on the issue response, from `contentSha256`.
- PDF, `apps/backend/src/placements/certificate-pdf.ts`: Helvetica and Helvetica-Bold with WinAnsi, no embedded font, pages as needed, deterministic bytes per issue (`CreationDate` is `issuedAt`). It prints the assistant, the department, each semester with Oslo dates, schools, and days, the total, the issuer's name and seat title, and `issuedOn`. Text outside WinAnsi fails closed with `certificate.unprintable` inside the transaction, so no issue is recorded. A throwaway render parsed with `pdftotext` showed the Norwegian letters, the escaped parentheses, and identical bytes for a second render.

### Remaining steps

1. Backend HTTP tests, `apps/backend/src/placements/certificates-http.test.ts`, on `backendDatabase` and `makeCertificatesTestHttp`, with the `Identity`, `IdentitySnapshot`, and `OAuthCredentialAuthority` doubles of `team-application/http.test.ts`. Seed one independent department, a Styret leader, an outsider, and an assistant with an accepted legacy total (the cohort chain of `placements/certificates.test.ts`). Decode every body with the contract schemas. Cover:
   - confirm with the observed tag answers 200 with the next revision and its tag; a stale `If-Match` answers 412 `precondition.failed` and writes no confirmation;
   - the outsider answers 403 on the list and on issue, and the assistant answers 403 on their own certificate; no issue row;
   - an exact replay of one issue key returns identical PDF bytes and records one issue; a new key records a second row with the same content hash;
   - a replay after the issuer's membership ended answers 403;
   - a commit failure recovered in the same request: a sequence and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `certificate_issues` that raises SQLSTATE 40001 when `nextval` is 1 (a sequence is not rolled back) gives 200 and one issue row;
   - an assistant name outside WinAnsi (for example `Łukasz`) answers 422 `certificate.unprintable` with no issue row.
2. Dashboard: the folder `apps/dashboard/app/foldkit/certificates` needs a `tools/conventions/src/layout.ts` exception (context Placements) and its guide. Follow `foldkit/team-applications` (custom element in `elements.ts`, SDK adapter in `browser-client.ts`, `Command.define` commands, idempotency keys from a browser seed, one retried key per uncertain request). Replace the heading in `routes/dashboard.attester._index.tsx` with one Foldkit Model:
   - the scope choice;
   - days served per assistant, with the evidence and a confirm or adjust action that reloads on 412;
   - the certificate list and preview, which names the unconfirmed semesters before download;
   - the board rosters.
   The download command posts the issue through the SDK and saves the PDF bytes as a Blob; the receipt stores no `content-disposition`. Add `update.test.ts` and `view.test.ts`.
3. Golden journey: `tools/e2e/golden-certificates.ts`, its evidence module, and `apps/dashboard/e2e/golden-certificates-browser.ts` on `golden-harness.ts`, modelled on `golden-team-application.ts`. It covers journeys 1 to 4 and three faults, each followed by recovery:
   - a stale revision on confirmation;
   - the issuer's derived seat ended between page load and issue, then a new appointment;
   - the 40001 trigger at commit, recovered in the same request.
   The commit fault installs the sequence and deferred trigger of step 1 through the journey's pool. Add `certificates` to the `golden` recipe and the hosted matrix in `.github/workflows/tests.yml`, run `just layout write`, and pass 3 runs through `just measure`.
4. Update `docs/system.md` (Certificates; the derived seat roster under Organization administration), `STATE.md`, and `docs/model/contexts.cml`. There, `Certificate` becomes cumulative per assistant and department, and the capabilities become `placements.days-served` and `certificates.issue`. Then remove this specification.

### Decisions this specification did not cover

- A confirmed zero is no service: that semester is absent from the certificate and shown as confirmed zero. With no included semester, issue fails with `CertificateEmpty`.
- A certificate's schools are the schools of the evidence that its confirmation saw, stored in `evidence_json`.
- The content hash covers the assistant's and the department's names. A rename gives a new hash.
- An issuer who is also the assistant cannot issue their own certificate: the falsifier on assistant downloads wins over journey 3.
- Seat titles: `position, board` for an appointed seat, `position, team` for a derived seat (`Styremedlem` or `Leder` when the position is absent), and `Global administrator`.
- Names outside WinAnsi fail closed: the issue answers 422 `certificate.unprintable` and records nothing. No font is embedded.
- The scope read declares `certificates.issue` as its capability. It lists the departments where the reader holds either capability and denies nobody; the lists and commands decide per department.
- The issue response carries the certificate tag of the issued content, the same tag as the preview it was issued from.
- Confirmation is allowed before the semester ends, and a coordinator can confirm their own total.
