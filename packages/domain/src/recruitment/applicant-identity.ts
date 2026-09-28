import { dual } from "effect/Function";

/** Only an established Applicant-to-Person association proves a self-interview. */
export const isKnownSelfInterview: {
  (actorPersonId: string): (linkedApplicantPersonId: string | null) => boolean;
  (linkedApplicantPersonId: string | null, actorPersonId: string): boolean;
} = dual(
  2,
  (linkedApplicantPersonId: string | null, actorPersonId: string): boolean =>
    linkedApplicantPersonId !== null && linkedApplicantPersonId === actorPersonId,
);
