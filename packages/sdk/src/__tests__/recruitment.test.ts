import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
} from "../schemas/recruitment.js";
import {
  RecruitmentDecodeSdkError,
  RecruitmentUnauthenticatedActorError,
  createClient,
} from "../promise.js";

const command = {
  commandId: "command-1",
  applicationId: "application-1",
  interviewerPersonId: "person-1",
  interviewSchemaId: "schema-1",
} as const;

const board = {
  admissionPeriodId: "period-1",
  departmentId: "department-1",
  candidates: [],
  interviewers: [],
  interviewSchemas: [],
} as const;
const assignment = {
  observation: {
    _tag: "ApplicantAssigned",
    commandId: "command-1",
    interview: {
      interviewId: "interview-1",
      applicationId: "application-1",
      departmentId: "department-1",
      interviewerPersonId: "person-1",
      interviewSchemaId: "schema-1",
      assignedByPersonId: "leader-1",
      assignedAt: "2031-09-15T12:00:00.000Z",
      state: "NoContact",
      scheduledAt: null,
      revision: 0,
    },
  },
  replayed: false,
} as const;
const response = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

afterEach(() => vi.unstubAllGlobals());

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

describe("recruitment SDK transport", () => {
  it("uses the native board and assignment routes with strict observations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, board))
      .mockResolvedValueOnce(response(200, assignment));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "leader-token" });

    await expect(client.admin.recruitment.readAssignmentBoard({ status: "new" })).resolves.toEqual(
      board,
    );
    await expect(client.admin.recruitment.assignApplicant(command)).resolves.toEqual(assignment);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://api.test/api/admin/recruitment/assignment-board?status=new",
      expect.objectContaining({ method: "GET" }),
    );
    const [assignmentUrl, assignmentInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(assignmentUrl).toBe("http://api.test/api/admin/recruitment/interviews/assign");
    expect(JSON.parse(String(assignmentInit.body))).toEqual(command);
  });

  it("maps unauthenticated Recruitment responses and rejects excess observations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(401, { error: { tag: "UnauthenticatedActor" } }))
      .mockResolvedValueOnce(response(200, { ...board, unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "expired-token" });

    await expect(
      client.admin.recruitment.readAssignmentBoard({ status: "new" }),
    ).rejects.toBeInstanceOf(RecruitmentUnauthenticatedActorError);
    await expect(
      client.admin.recruitment.readAssignmentBoard({ status: "new" }),
    ).rejects.toBeInstanceOf(RecruitmentDecodeSdkError);
  });
});
