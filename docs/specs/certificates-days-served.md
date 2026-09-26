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

Branch `feat/certificates-0926` (CertificatesBuild, CertificatesBuild2, then CertificatesBuild3, 2026-09-26), rebased on main 9ed098b3. Domain, persistence, database falsifier tests, the HTTP contract, the backend handlers with the PDF, and the backend HTTP tests are committed; the migration is `0080-days-served-and-certificates.sql`. The backend is complete for this slice: the dashboard, the golden journey, and the documents remain (steps below).

### Done

- Domain, `packages/domain`:
  - `authz/delegation.ts`: the delegable capability `placements.days-served` (board leaders and global administrators; `TeamArea`). The department grants it to Skolekoordinering by delegation.
  - `authz/reach.ts`: `certificateIssuerBasis` implements journey 3. An appointed seat comes first, then a derived seat, then the global-administrator grant. `derivedBoardSeats` projects current team leadership onto Styret or Hovedstyret. No reach reads a derived seat.
  - `organization/board-roster.ts`: `BoardRosters`, `CertificateIssuer`, and `issuerSeatTitle`.
  - `placements/days-served.ts`: distinct Oslo dates plus accepted legacy totals, the calculated count, the entry version (revision and evidence digest), the confirmation, the command, and name-keyed pages of 50.
  - `placements/certificate.ts`: the content (confirmed totals above zero, oldest first), the content hash, the preview with each semester's status, the issue, and the scopes.
  - `placements/certificate-failures.ts`: typed failures without HTTP status.
  - Service contracts: `Placements` gains `readCertificateScopes`, `readDaysServed`, `confirmDaysServed`, `listCertificates`, `readCertificate`, `issueCertificate`, and `authorizeCertificateCommand`. These resolve authority themselves in the caller's transaction. `Organization` gains `readBoardRosters`.
  - Tests that fail when a rule breaks: `authz/certificate-issuer.test.ts`, `placements/days-served.test.ts`, and `placements/certificate.test.ts`.
- Persistence, `packages/database`:
  - `migrations/0080-days-served-and-certificates.sql` (checksum recorded): the capability check, `days_served_confirmations` (append-only, a trigger allows only the next revision), and `certificate_issues` (append-only, `issued_by_person_id <> person_id`).
  - `placements/certificates.ts`: counted attendance is `Completed` decisions of dated commitments only. Commands take the department row lock, then the person lock and the `ForShare` authority. The scope read denies a reader who holds neither capability in any department.
  - `organization/authority-postgres.ts` and `organization/lifecycle-postgres.ts`: governed departments, the certificate issuer, and `readBoardRosters` (the visibility of appointment management).
- Database falsifier tests, `packages/database/src/placements/certificates.test.ts` (6 tests on `DatabaseTestLive`), each with a negative control that failed the suite.
- HTTP contract, `packages/http-api/src/certificates.ts` (group `certificates`, six endpoints) and `GET /api/organization/board-rosters`. The scope read declares `placements.days-served` with `certificates.issue` as its alternative (`personNativeAccess` takes `alternatives`, an `Any` capability expression). `certificate.empty` (409) and `certificate.unprintable` (422) are in the problem registry.
- Backend, `apps/backend/src/placements/certificates-http.ts`: reads in one repeatable-read snapshot; commands through `executeNativeHttpCommandPostgres` with `retry: "serialization-once"`, current authority before any replay, and `If-Match` on the fresh entry or preview.
- PDF, `apps/backend/src/placements/certificate-pdf.ts` and `true-type.ts`: embedded subsets of Noto Sans Regular and Bold 2.015 (unhinted, OFL) as `CIDFontType2` with `Identity-H`, widths, and a ToUnicode map; deterministic bytes per issue. `fonts/` holds the unchanged release files, `OFL.txt`, and `provenance.json` (archive URL and SHA-256 of each file). `CertificateFontsLive` loads the fonts once with the handler group. Text that no glyph of both faces covers (CJK, controls) fails with `certificate.unprintable` inside the transaction, so no issue is recorded. Poppler (`pdffonts`, `pdftotext`, `pdftoppm`) and `qpdf --check` accepted a two-page render with Polish, Greek, and Cyrillic names.
- Tests, `apps/backend/src/placements/certificate-pdf.test.ts` (3: provenance checksums, names extracted through the ToUnicode maps, refusal by field) and `certificates-http.test.ts` (6, on PostgreSQL): the scope read for either capability and 403 for neither; 200 at the observed tag, 412 on a stale tag with no write, and read-back; 403 for the outsider and the assistant with no issue row; an exact replay with identical PDF bytes and one issue, a new key with a second issue and the same content hash, and 403 on a replay after the seat ended; a SQLSTATE 40001 deferred-trigger fault at commit recovered in the same request (two commit attempts, one issue); and 422 for a name outside the fonts. Negative controls, each reverted, failed the suite: no authority check before replay, no commit retry, and no confirmation precondition.

### Remaining steps

1. Dashboard, `apps/dashboard/app/foldkit/certificates` (context Placements): add the folder to `contextLayers["apps/dashboard/app/foldkit"]` in `tools/conventions/src/layout.ts`, its `AGENTS.md` and `CLAUDE.md` (`just guides write`), register the element in `entry.client.tsx`, and render it from `routes/dashboard.attester._index.tsx`. Follow `foldkit/team-applications`: `elements.ts` (custom element, idempotency seed from `crypto.randomUUID()`), `browser-client.ts` (SDK groups `certificates` and `organization`, failures as problem codes, and `saveDocument`, which saves the PDF bytes as a Blob through an object URL and a download link named by the dashboard), `command.ts` (`Command.define` per operation; the issue command saves the bytes only after the issue answers 200), `model.ts`, `message.ts`, `update.ts`, `view.ts`, and `styles.css`. One Model holds: the scopes (`AsyncData`), the chosen department and semester (the first of each by default, the scope read orders semesters newest first), the days-served page with its cursor, page number, request id, and the typed total per person; the certificate page likewise; the selected person and the preview; the board rosters; the mutation (`Idle` or `Sending` with the exact request), the uncertain request whose key a retry repeats, the idempotency seed and sequence, and the notice. Rules: a stale `If-Match` (412) on confirmation reloads the days-served page; a confirmation replaces its entry in place and reloads the certificate list and the open preview; the preview names the unconfirmed semesters before download and disables download without content; a denied issue reloads the scopes and the preview; `Unavailable` keeps the request so that a retry repeats its key. Messages carry the raw `<select>` value, and the update accepts only a department or semester that the scopes list. Add `update.test.ts` (transitions, including the repeated key after `Unavailable` and the reload after 412, over the generated SDK with a recording fetch, as in `team-applications/update.test.ts`) and `view.test.ts` (`Scene` of `foldkit/test`: unconfirmed semesters named, download disabled without content, derived seats marked on the roster, keyed rows). Unverified drafts of these files may remain in `/tmp/cert-dashboard` on the machine of CertificatesBuild3; this step is authoritative.
2. Golden journey: `tools/e2e/golden-certificates.ts`, its evidence module, and `apps/dashboard/e2e/golden-certificates-browser.ts` on `golden-harness.ts`, modelled on `golden-team-application.ts`. It covers journeys 1 to 4 and three faults, each followed by recovery:
   - a stale revision on confirmation;
   - the issuer's derived seat ended between page load and issue, then a new appointment;
   - the 40001 trigger at commit, recovered in the same request (the sequence and `DEFERRABLE INITIALLY DEFERRED` constraint trigger of `certificates-http.test.ts`, installed through the journey's pool).
   Add `certificates` to the `golden` recipe and the hosted matrix in `.github/workflows/tests.yml`, run `just layout write`, and pass 3 runs through `just measure`.
3. Update the system document (Certificates; the derived seat roster under Organization administration): `apps/docs/content/docs/system.mdx` once the Fumadocs site has landed, otherwise `docs/system.md`. Update `STATE.md` and `docs/model/contexts.cml`, where `Certificate` becomes cumulative per assistant and department and the capabilities become `placements.days-served` and `certificates.issue`. Then remove this specification.

### Decisions this specification did not cover

- A confirmed zero is no service: that semester is absent from the certificate and shown as confirmed zero. With no included semester, issue fails with `CertificateEmpty`.
- A certificate's schools are the schools of the evidence that its confirmation saw, stored in `evidence_json`.
- The content hash covers the assistant's and the department's names. A rename gives a new hash.
- An issuer who is also the assistant cannot issue their own certificate: the falsifier on assistant downloads wins over journey 3.
- Seat titles: `position, board` for an appointed seat, `position, team` for a derived seat (`Styremedlem` or `Leder` when the position is absent), and `Global administrator`.
- A name prints when both faces have a glyph for each of its characters after NFC normalization; control characters never print.
- The issue response carries the certificate tag of the issued content, the same tag as the preview it was issued from.
- Confirmation is allowed before the semester ends, and a coordinator can confirm their own total.
