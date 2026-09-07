import { Schema } from "effect";
import { AdmissionPeriodId, AdmissionPeriodProjectionSchema } from "../admission-period/schema.js";
import { DepartmentId } from "../organization/schema.js";
import { Rfc3339InstantSchema } from "../time.js";
import {
  InterviewRecommendationSchema,
  RecruitmentInterviewId,
  RecruitmentInterviewScoreSchema,
} from "./schema.js";

export const InterviewReportFilter = Schema.Literals([
  "all",
  "Ja",
  "Kanskje",
  "Nei",
  "not-recorded",
]);
export const InterviewReportSort = Schema.Literals(["applicant", "recommendation", "total"]);
export const InterviewReportDirection = Schema.Literals(["asc", "desc"]);
export const InterviewReportQuery = Schema.Struct({
  admissionPeriodId: Schema.optional(AdmissionPeriodId),
  recommendation: Schema.optional(InterviewReportFilter),
  sort: Schema.optional(InterviewReportSort),
  direction: Schema.optional(InterviewReportDirection),
});
export type InterviewReportQuery = typeof InterviewReportQuery.Type;
export const InterviewReportRow = Schema.Struct({
  interviewId: RecruitmentInterviewId,
  firstName: Schema.String,
  lastName: Schema.String,
  completedAt: Rfc3339InstantSchema,
  recommendation: Schema.NullOr(InterviewRecommendationSchema),
  ...RecruitmentInterviewScoreSchema.fields,
});
export type InterviewReportRow = typeof InterviewReportRow.Type;
export const InterviewReport = Schema.Struct({
  departmentId: DepartmentId,
  periods: Schema.Array(AdmissionPeriodProjectionSchema),
  selectedPeriodId: Schema.NullOr(AdmissionPeriodId),
  recommendation: InterviewReportFilter,
  sort: InterviewReportSort,
  direction: InterviewReportDirection,
  rows: Schema.Array(InterviewReportRow),
}).annotate({ identifier: "CompletedInterviewReport" });
export type InterviewReport = typeof InterviewReport.Type;
export const interviewScoreTotal = (
  row: Pick<InterviewReportRow, "explanatoryPower" | "roleModel" | "suitability">,
) => row.explanatoryPower + row.roleModel + row.suitability;
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** Pure view derivation; the caller supplies only authorized rows. */
export const orderInterviewReport = (
  rows: ReadonlyArray<InterviewReportRow>,
  query: InterviewReportQuery,
) => {
  const filter = query.recommendation ?? "all";
  const direction = query.direction === "desc" ? -1 : 1;
  return rows
    .filter((row) => filter === "all" || (row.recommendation ?? "not-recorded") === filter)
    .toSorted((left, right) => {
      const primary =
        query.sort === "total"
          ? interviewScoreTotal(left) - interviewScoreTotal(right)
          : query.sort === "recommendation"
            ? compareText(
                left.recommendation ?? "Ikke registrert",
                right.recommendation ?? "Ikke registrert",
              )
            : compareText(
                `${left.lastName} ${left.firstName}`,
                `${right.lastName} ${right.firstName}`,
              );
      return primary * direction || compareText(left.interviewId, right.interviewId);
    });
};
