import { Effect, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ApplicationAdmissionEvidence,
  AdmissionOutcomeFailure,
} from "@vektorprogrammet/domain/admissions";
import type { PublicApplicationId } from "@vektorprogrammet/domain/application";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import type { DatabaseOperations } from "../service.js";

/** Fences this application's decision-sensitive writes in the caller's transaction.
 * @remarks Updates the application-owned version through the same SQL owner used by decision,
 * correction and window backstops. Unlike a row lock alone, this invalidates old snapshots.
 * @sideEffects Waits for application row custody and increments its fence version until commit or rollback.
 * @example
 * ```ts
 * yield* lockApplicationDecisionWithSql(sql, applicationId);
 * ```
 * @avoid Calling outside the transaction that writes, or acquiring it before applicant custody.
 * @construct sql-lifecycle
 */

export const lockApplicationDecisionWithSql: (
  sql: DatabaseOperations,
  applicationId: PublicApplicationId,
) => Effect.Effect<void, SqlError> = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  applicationId: PublicApplicationId,
): Effect.fn.Return<void, SqlError> {
  yield* sql`SELECT public.fence_application_decision(${applicationId})`;
});

/** Reads decoded admission evidence from the application's own period and semester.
 * @remarks The SQL view owns live versus frozen citation selection and the public outcome projection.
 * Historical uncited decisions retain their outcome and never acquire a current assessment citation.
 * The caller owns authority, applicant custody and the transaction; lock=true takes the common fence.
 * @sideEffects Reads evidence and, on writes, acquires versioned application custody until transaction end.
 * @example
 * ```ts
 * const evidence = yield* readApplicationAdmissionEvidenceWithSql(sql, applicationId, departmentId, { lock: true });
 * ```
 * @avoid Treating a department selector as authority or observing eligibility before a lock wait.
 * @construct sql-lifecycle
 */

export const readApplicationAdmissionEvidenceWithSql: (
  sql: DatabaseOperations,
  applicationId: PublicApplicationId,
  departmentId: DepartmentId,
  options: { readonly lock: boolean },
) => Effect.Effect<
  ApplicationAdmissionEvidence,
  SqlError | Schema.SchemaError | AdmissionOutcomeFailure
> = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  applicationId: PublicApplicationId,
  departmentId: DepartmentId,
  options: { readonly lock: boolean },
): Effect.fn.Return<
  ApplicationAdmissionEvidence,
  SqlError | Schema.SchemaError | AdmissionOutcomeFailure
> {
  if (options.lock) yield* lockApplicationDecisionWithSql(sql, applicationId);

  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: ApplicationAdmissionEvidence,
    execute:
      () => sql`SELECT application_id AS "applicationId", admission_period_id AS "admissionPeriodId",
      department_id AS "departmentId", semester_id AS "semesterId",
      to_char(period_opens_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "periodOpensAt",
      to_char(period_closes_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "periodClosesAt",
      to_char(semester_starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "semesterStartsAt",
      to_char(semester_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "semesterEndsAt",
      basis,outcome,decision_closed AS "decisionClosed",interview_completed AS "interviewCompleted",
      interview_cancelled AS "interviewCancelled",returning_registered AS "returningRegistered",
      linked_person_id AS "linkedPersonId"
      FROM public.application_admission_evidence WHERE application_id=${applicationId} AND department_id=${departmentId}`,
  })(undefined);

  if (rows[0] === undefined)
    return yield* new AdmissionOutcomeFailure({ code: "resource.not-found", status: 404 });

  return rows[0];
});
