import { Schema } from "effect";
import { AdmissionPeriodId } from "../admission-period/schema.js";
import { PublicApplicationIdSchema } from "../application/schema.js";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { Instant } from "../time.js";
import { AdmissionOutcome, AdmissionOutcomeBasis } from "./outcome.js";

/** Evidence of this application's own period and semester. Closed decisions never read live assessments. */
export const ApplicationAdmissionEvidence = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
  admissionPeriodId: AdmissionPeriodId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  periodOpensAt: Instant,
  periodClosesAt: Instant,
  semesterStartsAt: Instant,
  semesterEndsAt: Instant,
  basis: AdmissionOutcomeBasis,
  outcome: Schema.NullOr(AdmissionOutcome),
  decisionClosed: Schema.Boolean,
  interviewCompleted: Schema.Boolean,
  interviewCancelled: Schema.Boolean,
  returningRegistered: Schema.Boolean,
  linkedPersonId: Schema.NullOr(PersonId),
});

export type ApplicationAdmissionEvidence = typeof ApplicationAdmissionEvidence.Type;
