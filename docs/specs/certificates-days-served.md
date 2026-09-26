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
