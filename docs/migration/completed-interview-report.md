# Fullførte intervjuer

The native coordinator report lives at `/dashboard/intervjuer/rapport`, linked
as **Fullførte intervjuer** in dashboard and interview navigation. Its bounded
contract is [0103](../../design-specs/0103-coordinator-interview-report.md).

## Experience the report

1. Sign in as an active department leader with one resolved active department.
2. Open **Fullførte intervjuer** and select **Opptaksperiode**, then **Vis rapport**.
   Closed historical periods are available; no selection means no results.
3. Compare the completed interviews, use the recommendation filter, and activate
   the applicant, recommendation or total-score column heading to sort.
4. Reload or revisit the URL. The selected period, filter and ordering remain
   explicit in the URL. The result count describes the displayed rows.

Historical missing recommendations display **Ikke registrert**. The total is the
sum of the three recorded native scores. The report does not classify previous
participation or make an admission decision. Returning-assistant registration
and exact legacy first-time-only population parity remain separate work.

## Boundaries

The dedicated `recruitment.readInterviewReport` SDK operation reads
`GET /api/recruitment/interview-report`. Its query and response are defined in
[the domain report schema](../../packages/domain/src/recruitment/report.ts)
and generated into the native API contract. The dashboard uses this single read;
it does not retrieve full interview answers through item endpoints.

Current canonical department authority is checked on each read. Known
self-assessments are excluded before filtering, sorting and counting. Reporting
does not update interviews or create command receipts, audit events or messages.
Navigation visibility is only a convenience; the backend owns access decisions.

Loading hides the previous observation. A failed read shows a retry action for
the requested selection instead of presenting old rows under a new period.
Responses are private and not stored in HTTP caches.

Local synthetic rehearsal evidence and production release are distinct. See the
frozen contract for the required browser, API, PostgreSQL, privacy and concurrent
identity-link acceptance gates. No production availability is claimed here.

The reusable local gate is `bun tools/preview-host/recommendation-check.ts --report`.
It builds the SDK and production dashboard and reuses the actual0101 interview
journey before exercising this report. Run its lightweight input check first:
`bun tools/preview-host/recommendation-check.ts --report --validate-fixture`. The isolated
verification lane passed at `58391ed6`; combined-commit acceptance and retained
artifacts are recorded separately.
