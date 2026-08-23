import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  InterviewSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentInterview,
} from "./schema.js";

it("derives immutable Recruitment Models without generated revision inputs", () => {
  expect(Object.keys(InterviewSchema.insert.fields)).not.toContain("revision");
  expect(Object.keys(InterviewSchema.update.fields)).not.toContain("interviewSchemaId");
  expect(Object.keys(RecruitmentInterview.insert.fields)).not.toContain("revision");
  expect(Object.keys(RecruitmentInterview.update.fields)).not.toContain("applicationId");
});

it.effect("strictly decodes board status and assignment commands", () =>
  Effect.gen(function* () {
    const query = yield* Schema.decodeUnknownEffect(RecruitmentAssignmentBoardQuerySchema)(
      { status: "new" },
      { onExcessProperty: "error" },
    );
    expect(query.status).toBe("new");
    const command = yield* Schema.decodeUnknownEffect(RecruitmentAssignmentCommandSchema)(
      {
        commandId: "command-1",
        applicationId: "application-1",
        interviewerPersonId: "person-1",
        interviewSchemaId: "schema-1",
      },
      { onExcessProperty: "error" },
    );
    expect(command.applicationId).toBe("application-1");
    const failure = yield* Effect.flip(
      Schema.decodeUnknownEffect(RecruitmentAssignmentBoardQuerySchema)(
        { status: "pending" },
        { onExcessProperty: "error" },
      ),
    );
    expect(String(failure)).toContain("pending");
  }),
);
