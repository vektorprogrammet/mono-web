// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noLiteralWindowInstantRule } from "./no-literal-window-instant.ts";

RuleTester.describe = describe;
RuleTester.it = it;

// The lint clock of the seed-date incident: the seeds' admission period ended four days later.
const incident = [{ now: "2026-09-26T00:00:00.000Z" }];

const literalWindowInstant = (bound: string, instant: string) => ({
  messageId: "literalWindowInstant",
  data: { bound, instant },
});

// The conduct seed before 501b1cbd: a semester, an admission period, and a claimed invitation.
const conductSeed = `
const sql = \`
INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('\${semesterId}', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z') ON CONFLICT (semester_id) DO NOTHING;
INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id)
VALUES ('\${periodId}', '\${departmentId}', '\${semesterId}', '2026-08-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z', 0, 'admission-period-native-conduct-seed-0063')
ON CONFLICT (admission_period_id) DO NOTHING;
INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at, revision)
VALUES
 ('\${applicationA}', '\${applicantA}', '\${periodId}', '\${departmentId}', '\${fieldId}', 3, '2026-08-20T10:00:00.000Z', 0)
ON CONFLICT (application_id) DO NOTHING;
INSERT INTO applicant_account_invitations (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
VALUES ('applicant-account-native-conduct-a-0063', '\${applicationA}', '\${applicantA}', repeat('c', 64), '2027-01-01T00:00:00.000Z', 'Claimed', '\${persons.leader.personId}', '2026-09-01T00:00:00.000Z')
ON CONFLICT (invitation_id) DO NOTHING;
\`;
`;

// The recruitment seed before 501b1cbd.
const recruitmentSeed = `
const membershipStartAt = "2026-01-01T00:00:00.000Z";
const semesterStartAt = "2026-01-01T00:00:00.000Z";
const semesterEndAt = "2027-01-01T00:00:00.000Z";
const periodStartAt = "2026-08-01T00:00:00.000Z";
const periodEndAt = "2026-09-30T23:59:59.999Z";
`;

new RuleTester().run("no-literal-window-instant", noLiteralWindowInstantRule, {
  valid: [
    // Negative controls: historical window bounds, which the clock has passed for good.
    {
      code: "const sql = `INSERT INTO organization_memberships (membership_id, start_at, end_at) VALUES ('m', '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z')`;",
      options: incident,
    },
    { code: "const expiredEndAt = '2020-01-01T00:00:00.000Z';", options: incident },
    // The same seed windows once the clock has passed them.
    { code: conductSeed, options: [{ now: "2027-01-02T00:00:00.000Z" }] },
    // Future instants outside a window bound.
    {
      code: "const sql = `INSERT INTO admission_applications (application_id, submitted_at) VALUES ('a', '2031-09-10T10:00:00.000Z')`;",
      options: incident,
    },
    { code: "const receiptDate = '2031-01-01';", options: incident },
    {
      code: "createEvent({ startAt: '2030-02-01T18:00:00.000Z', endAt: '2030-02-01T20:00:00.000Z' });",
      options: incident,
    },
    {
      code: "const environment = { ADMISSION_FIXED_NOW: '2031-09-15T12:00:00.000Z' };",
      options: incident,
    },
    // Instants through the helper.
    {
      code: "const clock = journeyClock('2031-09-15T12:00:00.000Z'); const periodEndAt = clock.fromNow(16);",
      options: incident,
    },
    // Digits that are not calendar instants.
    { code: "const periodEndAt = '2031-02-30T10:00:00.000Z';", options: incident },
    { code: "const scheduledAt = '20310920';", options: incident },
    // A date in a comment.
    {
      code: "// The period ends on 2031-10-01.\nconst periodEndAt = clock.fromNow(16);",
      options: incident,
    },
    // A comparison with a literal binds nothing.
    { code: "const periodEndAt = value === '2031-10-01' ? first : second;", options: incident },
  ],
  invalid: [
    {
      code: conductSeed,
      options: incident,
      errors: [
        literalWindowInstant("end_at", "2027-01-01T00:00:00.000Z"),
        // Oxlint RuleTester columns count from 0.
        { ...literalWindowInstant("end_at", "2026-09-30T23:59:59.999Z"), line: 5, column: 88 },
        literalWindowInstant("expires_at", "2027-01-01T00:00:00.000Z"),
      ],
    },
    {
      code: recruitmentSeed,
      options: incident,
      errors: [
        literalWindowInstant("semesterEndAt", "2027-01-01T00:00:00.000Z"),
        literalWindowInstant("periodEndAt", "2026-09-30T23:59:59.999Z"),
      ],
    },
    {
      code: "const schedule = { scheduledAt: '2031-09-20T13:30:00.000Z', room: 'K-101' };",
      options: incident,
      errors: [
        {
          ...literalWindowInstant("scheduledAt", "2031-09-20T13:30:00.000Z"),
          column: 33,
          endColumn: 57,
        },
      ],
    },
    {
      code: "requestSettlement(origin, { settledAt: '2099-01-01T00:00:00.000Z' });",
      options: incident,
      errors: [literalWindowInstant("settledAt", "2099-01-01T00:00:00.000Z")],
    },
    {
      code: "pool.query(`UPDATE public.admission_periods SET end_at='2026-12-31T23:59:59.999Z' WHERE admission_period_id=$1`, [id]);",
      options: incident,
      errors: [
        {
          ...literalWindowInstant("end_at", "2026-12-31T23:59:59.999Z"),
          column: 56,
          endColumn: 80,
        },
      ],
    },
    {
      code: "seedQuery('next period', 'INSERT INTO public.admission_periods(admission_period_id,start_at,end_at) VALUES($1,$2,$3)', [id, '2026-08-02T00:00:00Z', '2026-12-31T23:59:59.999Z']);",
      options: incident,
      errors: [literalWindowInstant("end_at", "2026-12-31T23:59:59.999Z")],
    },
    {
      code: "sql`UPDATE admission_periods SET end_at = ${closed ? '2026-12-31T00:00:00Z' : endAt}`;",
      options: incident,
      errors: [literalWindowInstant("end_at", "2026-12-31T00:00:00Z")],
    },
    {
      code: "const sql = `INSERT INTO recruitment_interview_schedules(interview_id,scheduled_at) SELECT interview_id,'2026-10-02T10:00:00Z' FROM recruitment_interviews`;",
      options: incident,
      errors: [literalWindowInstant("scheduled_at", "2026-10-02T10:00:00Z")],
    },
  ],
});
