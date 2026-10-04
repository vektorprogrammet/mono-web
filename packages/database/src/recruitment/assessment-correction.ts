import { Effect, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import {
  assessmentCorrection,
  RecruitmentInterviewId,
  RecruitmentInterviewNotFound,
} from "@vektorprogrammet/domain/recruitment";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Instant } from "@vektorprogrammet/domain/time";
import type { DatabaseOperations } from "../service.js";

const Evidence = Schema.Struct({
  decisionClosed: Schema.Boolean,
  completed: Schema.Boolean,
  cancelled: Schema.Boolean,
  semesterEndsAt: Instant,
  sequence: Schema.Int,
  window: Schema.NullOr(
    Schema.Struct({
      openedBy: PersonId,
      openedAt: Instant,
      endsAt: Instant,
      closedAt: Schema.NullOr(Instant),
    }),
  ),
});

/** Same pure rule projects staff controls and gates corrections after taking the decision fence. */
export const readAssessmentCorrectionWithSql = Effect.fnUntraced(function* (
  sql: DatabaseOperations,
  interviewId: RecruitmentInterviewId,
  actor: {
    readonly personId: PersonId;
    readonly participant: boolean;
    readonly canMaintain: boolean;
  },
  at: Instant,
) {
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Evidence,
    execute: () => sql`SELECT e.decision_closed AS "decisionClosed",
      EXISTS(SELECT 1 FROM public.recruitment_interview_conducts c WHERE c.interview_id=i.interview_id) AS completed,
      EXISTS(SELECT 1 FROM public.recruitment_interview_cancellations c WHERE c.interview_id=i.interview_id) AS cancelled,
      to_char(e.semester_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "semesterEndsAt",
      COALESCE(w.sequence,0) AS sequence,
      CASE WHEN w.sequence IS NULL THEN NULL ELSE jsonb_build_object('openedBy',w.opened_by,
        'openedAt',to_char(w.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char(w.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'closedAt',CASE WHEN w.closed_at IS NULL THEN NULL ELSE to_char(w.closed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) END AS window
      FROM public.recruitment_interviews i JOIN public.application_admission_evidence e USING(application_id)
      LEFT JOIN LATERAL (SELECT * FROM public.recruitment_assessment_correction_windows WHERE interview_id=i.interview_id ORDER BY sequence DESC LIMIT 1) w ON true
      WHERE i.interview_id=${interviewId}`,
  })(undefined);

  if (rows[0] === undefined) return yield* new RecruitmentInterviewNotFound({ interviewId });

  return assessmentCorrection(rows[0], actor, at);
});
