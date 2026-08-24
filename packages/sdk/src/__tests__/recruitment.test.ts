import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentScheduleCommandSchema,
  RecruitmentInvitationResponseStateSchema,
  RecruitmentSchedulingBoardSchema,
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
      revision: 0,
    },
  },
  replayed: false,
} as const;
const scheduleCommand = {
  commandId: "schedule-command-1",
  interviewId: "interview-1",
  expectedRevision: 0,
  scheduledAt: "2031-09-20T10:00:00.000Z",
  room: "A101",
  campus: null,
  mapLink: "https://example.invalid/map",
  message: "Welcome to the interview",
} as const;
const schedulingBoard = {
  departmentId: "department-1",
  interviews: [
    {
      interviewId: "interview-1",
      applicationId: "application-1",
      departmentId: "department-1",
      interviewer: {
        personId: "person-1",
        displayName: "Interviewer One",
        email: "interviewer@example.invalid",
        phone: "90000000",
      },
      applicant: {
        applicationId: "application-1",
        applicantId: "applicant-1",
        firstName: "Applicant",
        lastName: "One",
        email: "applicant@example.invalid",
        phone: "91111111",
      },
      revision: 1,
      schedule: null,
      responseState: "Rejected",
      responseMessage: "Unable to attend",
      notificationState: "Pending",
    },
  ],
} as const;
const scheduleResult = {
  observation: {
    _tag: "InterviewScheduled",
    commandId: "schedule-command-1",
    interviewId: "interview-1",
    schedule: {
      interviewId: "interview-1",
      scheduledAt: "2031-09-20T10:00:00.000Z",
      room: "A101",
      campus: null,
      mapLink: "https://example.invalid/map",
      message: "Welcome to the interview",
      scheduledByPersonId: "person-1",
      committedAt: "2031-09-15T12:00:00.000Z",
      scheduleRevision: 1,
    },
    interviewRevision: 1,
    responseState: "Pending",
    notificationState: "Pending",
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
    expect(() =>
      Schema.decodeUnknownSync(RecruitmentScheduleCommandSchema)(
        { ...scheduleCommand, unexpected: true },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
        { ...schedulingBoard, unexpected: true },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });

  it("strictly decodes every native invitation state and staff response message", () => {
    for (const state of [
      "Pending",
      "Accepted",
      "Rejected",
      "RequestedNewTime",
    ] as const) {
      expect(
        Schema.decodeUnknownSync(
          RecruitmentInvitationResponseStateSchema,
        )(state),
      ).toBe(state);
    }
    expect(() =>
      Schema.decodeUnknownSync(
        RecruitmentInvitationResponseStateSchema,
      )("Cancelled"),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
        schedulingBoard,
        { onExcessProperty: "error" },
      ).interviews[0],
    ).toMatchObject({
      responseState: "Rejected",
      responseMessage: "Unable to attend",
    });
    expect(() =>
      Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
        {
          ...schedulingBoard,
          interviews: [
            {
              ...schedulingBoard.interviews[0],
              responseMessage: "Unable to attend",
              unexpected: true,
            },
          ],
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
        {
          ...schedulingBoard,
          interviews: [
            {
              ...schedulingBoard.interviews[0],
              responseState: "Rejected",
              responseMessage: null,
            },
          ],
        },
        { onExcessProperty: "error" },
      ).interviews[0]?.responseMessage,
    ).toBeNull();
    expect(
      Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
        {
          ...schedulingBoard,
          interviews: [
            {
              ...schedulingBoard.interviews[0],
              responseState: "RequestedNewTime",
              responseMessage: "  Please reschedule  ",
            },
          ],
        },
        { onExcessProperty: "error" },
      ).interviews[0]?.responseMessage,
    ).toBe("Please reschedule");
    for (const [responseState, responseMessage] of [
      [null, "Impossible"],
      ["Pending", "Impossible"],
      ["Accepted", "Impossible"],
      ["RequestedNewTime", null],
    ] as const) {
      expect(() =>
        Schema.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(
          {
            ...schedulingBoard,
            interviews: [
              {
                ...schedulingBoard.interviews[0],
                responseState,
                responseMessage,
              },
            ],
          },
          { onExcessProperty: "error" },
        ),
      ).toThrow();
    }
  });
});

describe("recruitment SDK transport", () => {
  it("uses all native Recruitment routes with strict observations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, board))
      .mockResolvedValueOnce(response(200, assignment))
      .mockResolvedValueOnce(response(200, schedulingBoard))
      .mockResolvedValueOnce(response(200, scheduleResult));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "leader-token" });

    await expect(client.admin.recruitment.readAssignmentBoard({ status: "new" })).resolves.toEqual(
      board,
    );
    await expect(client.admin.recruitment.assignApplicant(command)).resolves.toEqual(assignment);
    await expect(client.admin.recruitment.readSchedulingBoard()).resolves.toEqual(schedulingBoard);
    await expect(client.admin.recruitment.scheduleInterview(scheduleCommand)).resolves.toEqual(
      scheduleResult,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://api.test/api/admin/recruitment/assignment-board?status=new",
      expect.objectContaining({ method: "GET" }),
    );
    const [assignmentUrl, assignmentInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(assignmentUrl).toBe("http://api.test/api/admin/recruitment/interviews/assign");
    expect(JSON.parse(String(assignmentInit.body))).toEqual(command);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://api.test/api/admin/recruitment/interviews/scheduling-board",
      expect.objectContaining({ method: "GET" }),
    );
    const [scheduleUrl, scheduleInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(scheduleUrl).toBe("http://api.test/api/admin/recruitment/interviews/schedule");
    expect(JSON.parse(String(scheduleInit.body))).toEqual(scheduleCommand);
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
