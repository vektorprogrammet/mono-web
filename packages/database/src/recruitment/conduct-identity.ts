import { Effect } from "effect";
import { Database } from "../service.js";
import { lockOnboardingApplicant } from "../onboarding/postgres.js";
import type { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  RecruitmentInterviewNotFound,
  RecruitmentScopeDenied,
} from "@vektorprogrammet/domain/recruitment";
import type { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { isKnownSelfInterview } from "@vektorprogrammet/domain/recruitment";

/** Canonical0099 identity fact shared by domain custody and native access metadata. */
export const readInterviewApplicantIdentity = (interviewId: RecruitmentInterviewId) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        applicantId: string;
        departmentId: DepartmentId;
        linkedApplicantPersonId: PersonId | null;
      }>`SELECT a.applicant_id AS "applicantId",i.department_id AS "departmentId",l.person_id AS "linkedApplicantPersonId" FROM public.recruitment_interviews i JOIN public.admission_applications a USING(application_id) LEFT JOIN public.applicant_account_links l USING(applicant_id) WHERE i.interview_id=${interviewId}`;
      if (!rows[0]) return yield* new RecruitmentInterviewNotFound({ interviewId });
      return rows[0];
    }),
  );
/** Caller holds a transaction. Applicant custody precedes interview/receipt locks. */
export const guardInterviewApplicantIdentity = (
  interviewId: RecruitmentInterviewId,
  personId: PersonId,
) =>
  Effect.gen(function* () {
    const source = yield* readInterviewApplicantIdentity(interviewId);
    yield* lockOnboardingApplicant(source.applicantId);
    const current = yield* readInterviewApplicantIdentity(interviewId);
    if (isKnownSelfInterview(current.linkedApplicantPersonId, personId))
      return yield* new RecruitmentScopeDenied({ personId, departmentId: current.departmentId });
    return current;
  });
