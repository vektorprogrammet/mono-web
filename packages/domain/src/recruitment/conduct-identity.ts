import { Effect } from "effect";
import { Database } from "../database/service.js";
import { lockOnboardingApplicant } from "../onboarding/postgres.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";
import { RecruitmentInterviewNotFound, RecruitmentScopeDenied } from "./errors.js";
import type { RecruitmentInterviewId } from "./schema.js";

/** Caller holds a transaction. Applicant custody precedes interview/receipt locks.
 * Only the immutable0099 association establishes identity; absence remains unknown. */
export const guardInterviewApplicantIdentity = (
  interviewId: RecruitmentInterviewId,
  personId: PersonId,
) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        applicantId: string;
        departmentId: DepartmentId;
      }>`SELECT a.applicant_id AS "applicantId",i.department_id AS "departmentId" FROM public.recruitment_interviews i JOIN public.admission_applications a USING(application_id) WHERE i.interview_id=${interviewId}`;
      const row = rows[0];
      if (!row) return yield* new RecruitmentInterviewNotFound({ interviewId });
      yield* lockOnboardingApplicant(row.applicantId);
      const links = yield* sql<{
        personId: string;
      }>`SELECT person_id AS "personId" FROM public.applicant_account_links WHERE applicant_id=${row.applicantId}`;
      if (links[0]?.personId === personId)
        return yield* new RecruitmentScopeDenied({ personId, departmentId: row.departmentId });
    }),
  );
