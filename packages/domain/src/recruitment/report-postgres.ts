import { Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import { listAdmissionPeriodsForManagement } from "../admission-period/postgres.js";
import { Organization } from "../organization/service.js";
import { mapOrganizationAuthorityToRecruitmentActor } from "../organization/authority.js";
import type { PersonId } from "../organization/schema.js";
import { lockOnboardingApplicant } from "../onboarding/postgres.js";
import { isKnownSelfInterview } from "./applicant-identity.js";
import {
  RecruitmentDecodeError,
  RecruitmentRoleDenied,
  RecruitmentScopeDenied,
  RecruitmentPersistenceError,
} from "./errors.js";
import {
  InterviewReport,
  InterviewReportQuery,
  InterviewReportRow,
  orderInterviewReport,
} from "./report.js";

/** Same single-department recruitment policy, reconstructed from current Organization authority. */
export const resolveInterviewReportLeader = (personId: PersonId, now: string) =>
  Effect.gen(function* () {
    const organization = yield* Organization;
    const authority = yield* organization.resolvePersonAuthority(personId, now);
    const departments = [
      ...new Set(
        authority.memberships
          .filter((member) => member.active)
          .map((member) => member.departmentId),
      ),
    ];
    if (departments.length !== 1) return yield* new RecruitmentRoleDenied({ personId });
    const decision = mapOrganizationAuthorityToRecruitmentActor(authority, departments[0]!);
    if (
      decision._tag === "Deny" ||
      decision.value._tag !== "DepartmentLeader" ||
      !decision.value.active
    )
      return yield* new RecruitmentRoleDenied({ personId });
    return decision.value;
  });

/** No writes: fixed candidate set, deterministic applicant custody, then fresh identity observation. */
export const readCompletedInterviewReport = (
  personId: PersonId,
  now: string,
  input: InterviewReportQuery,
) =>
  Effect.gen(function* () {
    const query = yield* Schema.decodeUnknownEffect(InterviewReportQuery)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new RecruitmentDecodeError({ message: "invalid report query" })));
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const actor = yield* resolveInterviewReportLeader(personId, now);
          const periods = yield* listAdmissionPeriodsForManagement({ actor, now });
          if (
            query.admissionPeriodId !== undefined &&
            !periods.some((period) => period.id === query.admissionPeriodId)
          )
            return yield* new RecruitmentScopeDenied({
              personId,
              departmentId: actor.departmentId,
            });
          let rows: ReadonlyArray<InterviewReportRow> = [];
          if (query.admissionPeriodId !== undefined) {
            const candidates = yield* sql<{ interviewId: string; applicantId: string }>`
        SELECT i.interview_id AS "interviewId", a.applicant_id AS "applicantId"
        FROM public.recruitment_interviews i
        JOIN public.admission_applications a USING(application_id)
        JOIN public.recruitment_interview_conducts c USING(interview_id)
        WHERE a.department_id=${actor.departmentId} AND i.department_id=${actor.departmentId}
          AND a.admission_period_id=${query.admissionPeriodId}
        ORDER BY a.applicant_id, i.interview_id`;
            for (const applicantId of [...new Set(candidates.map((row) => row.applicantId))].sort())
              yield* lockOnboardingApplicant(applicantId);
            // 0037 versions applicant rows when links are inserted: old serializable
            // snapshots abort; READ COMMITTED gets the fresh link after lock acquisition.
            const observations = yield* sql<{
              interviewId: string;
              linkedPersonId: string | null;
              firstName: string;
              recommendation: string | null;
              participation: "Returning" | "Unknown";
              explanatoryPower: number;
              roleModel: number;
              suitability: number;
            }>`
        SELECT i.interview_id AS "interviewId", l.person_id AS "linkedPersonId",
          p.first_name AS "firstName", p.last_name AS "lastName",
          to_char(c.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
          c.recommendation,
          CASE WHEN rr.application_id IS NULL THEN 'Unknown' ELSE 'Returning' END AS participation,
          c.explanatory_power AS "explanatoryPower", c.role_model AS "roleModel", c.suitability
        FROM public.recruitment_interviews i
        JOIN public.admission_applications a USING(application_id)
        JOIN public.admission_applicants p USING(applicant_id)
        JOIN public.recruitment_interview_conducts c USING(interview_id)
        LEFT JOIN public.applicant_account_links l USING(applicant_id)
        LEFT JOIN LATERAL (
          SELECT r.application_id
          FROM public.admission_returning_registrations r
          WHERE r.application_id=i.application_id
          ORDER BY r.revision DESC
          LIMIT 1
        ) rr ON true
        WHERE a.department_id=${actor.departmentId} AND i.department_id=${actor.departmentId}
          AND a.admission_period_id=${query.admissionPeriodId}`;
            const candidateIds = new Set(candidates.map((row) => row.interviewId));
            rows = yield* Schema.decodeUnknownEffect(Schema.Array(InterviewReportRow))(
              observations
                .filter(
                  (row) =>
                    candidateIds.has(row.interviewId) &&
                    !isKnownSelfInterview(row.linkedPersonId, personId),
                )
                .map(({ linkedPersonId: _identity, ...row }) => row),
              { onExcessProperty: "error" },
            ).pipe(
              Effect.mapError(
                () => new RecruitmentDecodeError({ message: "invalid persisted report row" }),
              ),
            );
          }
          return {
            departmentId: actor.departmentId,
            periods,
            selectedPeriodId: query.admissionPeriodId ?? null,
            recommendation: query.recommendation ?? "all",
            participation: query.participation ?? "all",
            sort: query.sort ?? "applicant",
            direction: query.direction ?? "asc",
            rows: orderInterviewReport(rows, query),
          } satisfies InterviewReport;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new RecruitmentPersistenceError({
              operation: "read completed interview report",
              message: "report unavailable",
              cause,
            }),
          ),
        ),
      );
  });
