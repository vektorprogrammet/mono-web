import { RecruitmentSchedulingBoardSchema } from "@vektorprogrammet/domain/recruitment";
import {
  IdempotencyKey,
  ScheduleInterviewResponse,
  StrongETag,
  type ScheduleInterviewRequest,
} from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { AsyncData, Command } from "foldkit";
import { describe, expect, it } from "vitest";
import type { RecruitmentClient } from "../recruitment/browser-client";
import { makeSchedulingCommands } from "./command";
import {
  FailedLoadSchedulingBoard,
  FailedSchedule,
  Message,
  OpenedSchedule,
  SubmittedSchedule,
  SucceededLoadSchedulingBoard,
  SucceededSchedule,
  UpdatedCampus,
  UpdatedMapLink,
  UpdatedMessage,
  UpdatedRoom,
  UpdatedScheduledAt,
} from "./message";
import { makeInitialModel, type Model, type ReadyModel } from "./model";
import { makeUpdate } from "./update";
import { responseLabel } from "./view";

const decodeBoard = (value: unknown) =>
  S.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(value, {
    onExcessProperty: "error",
  });
const decodeResult = S.decodeUnknownSync(ScheduleInterviewResponse);

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);
const nextEtag = StrongETag.make(`"vkr2.${"B".repeat(43)}"`);
const rawInterview = {
  interviewId: "recruitment-interview-50",
  applicationId: "recruitment-application-50",
  departmentId: "department-trondheim",
  interviewer: {
    personId: "person-interviewer-50",
    displayName: "Grace Hopper",
    email: "grace@example.invalid",
    phone: "+4711111111",
  },
  applicant: {
    applicationId: "recruitment-application-50",
    applicantId: "recruitment-applicant-50",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.invalid",
    phone: "+4722222222",
  },
  etag,
} as const;

const unscheduledBoard = decodeBoard({
  departmentId: rawInterview.departmentId,
  interviews: [
    {
      ...rawInterview,
      revision: 0,
      schedule: null,
      responseState: null,
      responseMessage: null,
      notificationState: null,
    },
  ],
});

const freshSchedule = {
  interviewId: rawInterview.interviewId,
  scheduledAt: "2031-09-14T13:00:00.000Z",
  room: "Fresh read room",
  campus: "Gløshaugen",
  mapLink: "https://maps.example.invalid/interview-50",
  message: "Vi ser frem til å møte deg.",
  scheduledByPersonId: "person-leader-50",
  committedAt: "2031-09-01T10:00:00.000Z",
  scheduleRevision: 1,
} as const;

const freshBoard = decodeBoard({
  departmentId: rawInterview.departmentId,
  interviews: [
    {
      ...rawInterview,
      revision: 1,
      schedule: freshSchedule,
      responseState: "Pending",
      responseMessage: null,
      notificationState: "Pending",
    },
  ],
});

const inertClient: RecruitmentClient = {
  recruitment: {
    readSchedulingBoard: () => Effect.die("not executed by transition tests"),
    scheduleInterview: () => Effect.die("not executed by transition tests"),
    readAssignmentBoard: () => Effect.die("not executed by transition tests"),
    createApplicationInterview: () => Effect.die("not executed by transition tests"),
    readInterviewConduct: () => Effect.die("not executed by transition tests"),
    finalizeInterview: () => Effect.die("not executed by transition tests"),
    cancelInterview: () => Effect.die("not executed by transition tests"),
  },
};
const commands = makeSchedulingCommands(inertClient);
const update = makeUpdate(commands);

type SchedulingUpdate = (
  model: Model,
  message: Message,
) => readonly [Model, ReadonlyArray<Command.Command<Message>>];

const ready = (model: Model): ReadyModel => {
  if (model._tag !== "Ready") throw new Error("expected a ready scheduling model");
  return model;
};

const initialModel = (): ReadyModel =>
  ready(
    makeInitialModel(
      { _tag: "Loaded", board: unscheduledBoard },
      IdempotencyKey.make("scheduling-test-command"),
    ),
  );

const advance = (transition: SchedulingUpdate, model: Model, message: Message): ReadyModel =>
  ready(transition(model, message)[0]);

const validDraft = (transition: SchedulingUpdate): ReadyModel => {
  let model = advance(
    transition,
    initialModel(),
    OpenedSchedule({ interviewId: unscheduledBoard.interviews[0]!.interviewId }),
  );
  model = advance(transition, model, UpdatedScheduledAt({ value: "2031-09-14T15:00:00+02:00" }));
  model = advance(transition, model, UpdatedRoom({ value: "Rom 50" }));
  model = advance(transition, model, UpdatedCampus({ value: "Gløshaugen" }));
  model = advance(
    transition,
    model,
    UpdatedMapLink({ value: "https://maps.example.invalid/interview-50" }),
  );
  return advance(transition, model, UpdatedMessage({ value: "Vi ser frem til å møte deg." }));
};

const responseBoard = decodeBoard({
  departmentId: rawInterview.departmentId,
  interviews: [
    {
      ...rawInterview,
      revision: 1,
      schedule: freshSchedule,
      responseState: "Pending",
      responseMessage: null,
      notificationState: "Pending",
    },
    {
      ...rawInterview,
      revision: 1,
      schedule: freshSchedule,
      responseState: "Accepted",
      responseMessage: null,
      notificationState: "Delivered",
    },
    {
      ...rawInterview,
      revision: 1,
      schedule: freshSchedule,
      responseState: "Rejected",
      responseMessage: "Jeg kan dessverre ikke delta.",
      notificationState: "Pending",
    },
    {
      ...rawInterview,
      revision: 1,
      schedule: freshSchedule,
      responseState: "RequestedNewTime",
      responseMessage: "Kan vi avtale et senere tidspunkt?",
      notificationState: "Pending",
    },
  ],
});

describe("Foldkit scheduling transitions", () => {
  it("projects every invitation response label and only provided response messages", () => {
    const model = ready(
      makeInitialModel(
        { _tag: "Loaded", board: responseBoard },
        IdempotencyKey.make("response-test-command-01"),
      ),
    );
    const board = AsyncData.getData(model.board);
    expect(board._tag).toBe("Some");
    if (board._tag !== "Some") throw new Error("expected the response board observation");

    expect(
      board.value.interviews.map((interview) => ({
        label: responseLabel(interview.responseState),
        ...(interview.responseMessage === null ? {} : { message: interview.responseMessage }),
      })),
    ).toEqual([
      { label: "Venter på svar" },
      { label: "Akseptert" },
      { label: "Avvist", message: "Jeg kan dessverre ikke delta." },
      {
        label: "Ønsker nytt tidspunkt",
        message: "Kan vi avtale et senere tidspunkt?",
      },
    ]);
  });

  it("rejects capability and response-notification payload fields from board observations", () => {
    expect(() =>
      decodeBoard({
        departmentId: rawInterview.departmentId,
        interviews: [
          {
            ...rawInterview,
            revision: 1,
            schedule: freshSchedule,
            responseState: "Rejected",
            responseMessage: "Jeg kan dessverre ikke delta.",
            notificationState: "Pending",
            invitationCapability: "forbidden",
            responseNotificationPayload: { recipient: "forbidden@example.invalid" },
          },
        ],
      }),
    ).toThrow();
  });

  it("emits no schedule command for an invalid form", () => {
    const opened = advance(
      update,
      initialModel(),
      OpenedSchedule({ interviewId: unscheduledBoard.interviews[0]!.interviewId }),
    );

    const [invalid, emitted] = update(opened, SubmittedSchedule());

    expect(ready(invalid).scheduleError).toBe("Kontroller feltene og prøv igjen.");
    expect(emitted).toEqual([]);
  });

  it("emits exactly one first submit and blocks a duplicate while pending", () => {
    const [pending, emitted] = update(validDraft(update), SubmittedSchedule());

    expect(ready(pending).isScheduling).toBe(true);
    expect(emitted).toHaveLength(1);

    const [unchanged, duplicate] = update(pending, SubmittedSchedule());
    expect(unchanged).toBe(pending);
    expect(duplicate).toEqual([]);
  });

  it("uses a fresh scheduling-board read as the only success state replacement", async () => {
    let postCalls = 0;
    let readCalls = 0;
    let observedInput: {
      readonly params: { readonly interviewId: string };
      readonly headers: {
        readonly "idempotency-key": IdempotencyKey;
        readonly "if-match": StrongETag;
      };
      readonly payload: ScheduleInterviewRequest;
    } | null = null;
    const postObservationSchedule = {
      ...freshSchedule,
      room: "POST observation room",
    };
    const client: RecruitmentClient = {
      recruitment: {
        scheduleInterview: (input) =>
          Effect.sync(() => {
            postCalls += 1;
            observedInput = input;
            return decodeResult({
              observation: {
                _tag: "InterviewScheduled",
                commandId: input.headers["idempotency-key"],
                interviewId: input.params.interviewId,
                schedule: postObservationSchedule,
                interviewRevision: 1,
                responseState: "Pending",
                notificationState: "Pending",
              },
              replayed: false,
              etag: nextEtag,
            });
          }),
        readSchedulingBoard: () =>
          Effect.sync(() => {
            readCalls += 1;
            return freshBoard;
          }),
        readAssignmentBoard: () => Effect.die("not executed by transition tests"),
        createApplicationInterview: () => Effect.die("not executed by transition tests"),
        readInterviewConduct: () => Effect.die("not executed by transition tests"),
        finalizeInterview: () => Effect.die("not executed by transition tests"),
        cancelInterview: () => Effect.die("not executed by transition tests"),
      },
    };
    const flowUpdate = makeUpdate(makeSchedulingCommands(client));
    const [pending, emitted] = flowUpdate(validDraft(flowUpdate), SubmittedSchedule());
    const pendingBoard = AsyncData.getData(ready(pending).board);

    expect(pendingBoard._tag).toBe("Some");
    if (pendingBoard._tag !== "Some") throw new Error("expected the initial board observation");
    expect(pendingBoard.value).toEqual(unscheduledBoard);

    const successMessage = await Effect.runPromise(emitted[0]!.effect);
    if (successMessage._tag !== "SucceededSchedule") {
      throw new Error("expected a fresh scheduling-board success observation");
    }

    expect(postCalls).toBe(1);
    expect(readCalls).toBe(1);
    expect(observedInput).toMatchObject({
      params: { interviewId: unscheduledBoard.interviews[0]!.interviewId },
      headers: { "if-match": etag },
    });
    expect(successMessage).toEqual(
      SucceededSchedule({ requestId: ready(pending).boardRequestId, board: freshBoard }),
    );
    expect(successMessage.board.interviews[0]!.schedule?.room).toBe("Fresh read room");
    expect(successMessage.board.interviews[0]!.schedule?.room).not.toBe(
      postObservationSchedule.room,
    );

    const [completed] = flowUpdate(pending, successMessage);
    const completedModel = ready(completed);
    const completedBoard = AsyncData.getData(completedModel.board);
    expect(completedBoard._tag).toBe("Some");
    if (completedBoard._tag !== "Some") throw new Error("expected the fresh board observation");
    expect(completedBoard.value).toEqual(freshBoard);
    expect(completedModel.feedback).toBe(
      "Intervjuet er planlagt. Invitasjonen er lagt i kø for sending.",
    );
  });

  it("ignores stale load and schedule request observations", () => {
    const [pending] = update(validDraft(update), SubmittedSchedule());
    const current = {
      ...ready(pending),
      boardRequestId: ready(pending).boardRequestId + 1,
    };
    const staleRequestId = ready(pending).boardRequestId;
    const staleMessages = [
      SucceededLoadSchedulingBoard({ requestId: staleRequestId, board: freshBoard }),
      FailedLoadSchedulingBoard({ requestId: staleRequestId, message: "stale load" }),
      SucceededSchedule({ requestId: staleRequestId, board: freshBoard }),
      FailedSchedule({ requestId: staleRequestId, message: "stale schedule" }),
    ];

    for (const message of staleMessages) {
      const [next, emitted] = update(current, message);
      expect(next).toBe(current);
      expect(emitted).toEqual([]);
    }
  });
});
