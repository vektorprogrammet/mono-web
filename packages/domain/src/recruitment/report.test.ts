import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  InterviewReportQuery,
  InterviewReportRow,
  interviewScoreTotal,
  orderInterviewReport,
} from "./report.js";
const row = (
  id: string,
  recommendation: "Ja" | "Kanskje" | "Nei" | null,
  scores: [number, number, number],
) =>
  Schema.decodeUnknownSync(InterviewReportRow)({
    interviewId: id,
    firstName: "Sofie",
    lastName: "Søker",
    completedAt: "2031-09-15T12:00:00.000Z",
    recommendation,
    explanatoryPower: scores[0],
    roleModel: scores[1],
    suitability: scores[2],
  });
describe("completed interview report derivation", () => {
  it("keeps unrecorded historical recommendations separate and counts only selected rows", () => {
    const input = [
      row("a", null, [1, 2, 3]),
      row("b", "Nei", [1, 2, 3]),
      row("c", "Ja", [1, 2, 3]),
    ];
    expect(orderInterviewReport(input, { recommendation: "not-recorded" })).toEqual([input[0]]);
    expect(orderInterviewReport(input, { recommendation: "Nei" })).toEqual([input[1]]);
    expect(input).toHaveLength(3);
  });
  it("sorts scores numerically and resolves ties by immutable identity in either direction", () => {
    const input = [
      row("b", "Ja", [10, 0, 0]),
      row("a", "Kanskje", [5, 5, 0]),
      row("c", "Nei", [2, 0, 0]),
    ];
    expect(input.map(interviewScoreTotal)).toEqual([10, 10, 2]);
    expect(orderInterviewReport(input, { sort: "total" }).map((r) => r.interviewId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(
      orderInterviewReport(input, { sort: "total", direction: "desc" }).map((r) => r.interviewId),
    ).toEqual(["a", "b", "c"]);
  });
  it("does not accept caller authority or classification fields", () => {
    for (const extra of [
      { departmentId: "foreign" },
      { previousParticipation: false },
      { personId: "reader" },
    ])
      expect(() =>
        Schema.decodeUnknownSync(InterviewReportQuery)(extra, { onExcessProperty: "error" }),
      ).toThrow();
  });
});
