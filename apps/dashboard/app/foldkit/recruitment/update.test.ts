import { RecruitmentAssignmentBoardSchema } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { describe, expect, it } from "vitest";
import type { RecruitmentClient } from "./browser-client";
import { makeRecruitmentCommands } from "./command";
import {
  FailedAssignment,
  OpenedAssignment,
  SelectedFilter,
  SelectedInterviewer,
  SelectedSchema,
  SubmittedAssignment,
  SucceededAssignment,
} from "./message";
import { makeInitialModel } from "./model";
import { makeUpdate } from "./update";

const decodeBoard = S.decodeUnknownSync(RecruitmentAssignmentBoardSchema);

const unassignedBoard = decodeBoard({
  admissionPeriodId: "admission-period-autumn-2031",
  departmentId: "department-trondheim",
  candidates: [
    {
      applicationId: "application-ada",
      applicantId: "applicant-ada",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      submittedAt: "2031-09-02T09:00:00.000Z",
      applicationState: "Received",
      interviewState: "Unassigned",
      interviewer: null,
      interviewSchema: null,
      scheduledAt: null,
    },
  ],
  interviewers: [{ personId: "person-grace", displayName: "Grace Hopper" }],
  interviewSchemas: [
    {
      interviewSchemaId: "schema-first",
      name: "Førstegangsintervju",
      questionCount: 8,
      active: true,
      revision: 0,
    },
  ],
});

const assignedBoard = decodeBoard({
  ...unassignedBoard,
  candidates: [
    {
      ...unassignedBoard.candidates[0],
      interviewState: "NoContact",
      interviewer: { personId: "person-grace", displayName: "Grace Hopper" },
      interviewSchema: unassignedBoard.interviewSchemas[0],
    },
  ],
});

const client: RecruitmentClient = {
  admin: {
    recruitment: {
      readAssignmentBoard: () => Effect.die("not executed by transition tests"),
      assignApplicant: () => Effect.die("not executed by transition tests"),
    },
  },
};
const update = makeUpdate(makeRecruitmentCommands(client));

const readyModel = () => {
  const model = makeInitialModel(
    { _tag: "Loaded", status: "all", board: unassignedBoard },
    "recruitment-test-command",
  );
  if (model._tag !== "Ready") throw new Error("expected a ready recruitment model");
  return model;
};

describe("Foldkit recruitment transitions", () => {
  it("opens only an unassigned applicant and validates both choices", () => {
    const applicationId = unassignedBoard.candidates[0].applicationId;
    const [opened] = update(readyModel(), OpenedAssignment({ applicationId }));
    expect(opened).toMatchObject({ selectedApplicationId: applicationId, isAssigning: false });

    const [invalid, commands] = update(opened, SubmittedAssignment());
    expect(invalid).toMatchObject({ assignmentError: "Velg både intervjuer og intervjuskjema." });
    expect(commands).toEqual([]);
  });

  it("preserves selections after a failed assignment", () => {
    const candidate = unassignedBoard.candidates[0];
    const interviewer = unassignedBoard.interviewers[0];
    const schema = unassignedBoard.interviewSchemas[0];
    const [opened] = update(readyModel(), OpenedAssignment({ applicationId: candidate.applicationId }));
    const [withInterviewer] = update(
      opened,
      SelectedInterviewer({ personId: interviewer.personId }),
    );
    const [withSchema] = update(
      withInterviewer,
      SelectedSchema({ interviewSchemaId: schema.interviewSchemaId }),
    );
    const [submitting, commands] = update(withSchema, SubmittedAssignment());
    expect(submitting).toMatchObject({ isAssigning: true });
    expect(commands).toHaveLength(1);

    const [failed] = update(
      submitting,
      FailedAssignment({ message: "Intervjuet kunne ikke tildeles nå." }),
    );
    expect(failed).toMatchObject({
      isAssigning: false,
      selectedApplicationId: candidate.applicationId,
      selectedInterviewerPersonId: interviewer.personId,
      selectedInterviewSchemaId: schema.interviewSchemaId,
      assignmentError: "Intervjuet kunne ikke tildeles nå.",
    });
  });

  it("replaces the board only with the post-command observation", () => {
    const initial = readyModel();
    const [succeeded] = update(initial, SucceededAssignment({ board: assignedBoard }));
    if (succeeded._tag !== "Ready") throw new Error("expected a ready recruitment model");
    const board = AsyncData.getData(succeeded.board);
    expect(board._tag).toBe("Some");
    if (board._tag !== "Some") throw new Error("expected a successful board");
    expect(board.value).toEqual(assignedBoard);
    expect(succeeded).toMatchObject({
      selectedApplicationId: null,
      selectedInterviewerPersonId: null,
      selectedInterviewSchemaId: null,
      isAssigning: false,
      feedback: "Intervjuet er tildelt.",
    });
  });

  it("clears the dialog and loads a fresh board for each filter", () => {
    const [next, commands] = update(readyModel(), SelectedFilter({ status: "new" }));
    expect(next).toMatchObject({
      selectedFilter: "new",
      selectedApplicationId: null,
      feedback: null,
    });
    if (next._tag !== "Ready") throw new Error("expected a ready recruitment model");
    expect(AsyncData.isPending(next.board)).toBe(true);
    expect(commands).toHaveLength(1);
  });
});
