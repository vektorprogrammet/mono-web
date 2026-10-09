/**
 * EX-0021: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import type * as Statement from "effect/sql/Statement";
import type { DatabaseOperations } from "../service.js";

/** Capability openness is derived from original invitation and cancellation facts, never a flag. */
export const invitationOpen = (sql: DatabaseOperations, alias = "invitation"): Statement.Fragment =>
  sql`${sql(alias)}.superseded_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.recruitment_interview_cancellations AS cancellation
    WHERE cancellation.interview_id = ${sql(alias)}.interview_id
  )`;
