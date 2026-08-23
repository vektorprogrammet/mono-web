import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
} from "../schemas/recruitment.js";

const command = {
  commandId: "command-1",
  applicationId: "application-1",
  interviewerPersonId: "person-1",
  interviewSchemaId: "schema-1",
} as const;

describe("recruitment SDK wire schemas", () => {
  it("keeps assignment identifiers as branded string values", () => {
    const decoded = Schema.decodeUnknownSync(RecruitmentAssignmentCommandSchema)(command);

    expect(typeof decoded.commandId).toBe("string");
    expect(typeof decoded.applicationId).toBe("string");
    expect(typeof decoded.interviewerPersonId).toBe("string");
    expect(typeof decoded.interviewSchemaId).toBe("string");
    expect(decoded.interviewSchemaId).toBe("schema-1");
  });

  it("rejects excess query and command properties", () => {
    expect(() =>
      Schema.decodeUnknownSync(RecruitmentAssignmentBoardQuerySchema)(
        { status: "new", unexpected: true },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RecruitmentAssignmentCommandSchema)(
        { ...command, unexpected: true },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
