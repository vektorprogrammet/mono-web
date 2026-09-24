import { Dialog } from "@foldkit/ui";
import { RecruitmentBridgeFailure } from "../recruitment/bridge";
import { Predicate } from "effect";
import { RecruitmentInterviewConductObservationSchema } from "@vektorprogrammet/http-api"
import {
  IdempotencyKey,
  ScheduleInterviewResponse,
  SchedulingBoard,
  StrongETag,
  type ScheduleInterviewRequest,
} from "@vektorprogrammet/http-api";
import { Effect, Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { describe, expect, it } from "vitest";
import type { RecruitmentClient } from "../recruitment/browser-client";
import { commandsFor } from "./command";
import {
  ChangedAnswer,
  ClosedSchedule,
  GotScheduleDialogMessage,
  ChangedRecommendation,
  ChangedScore,
  FailedFinalize,
  FailedLoadSchedulingBoard,
  FailedSchedule,
  Message,
  OpenedSchedule,
  RequestedBoardRefresh,
  SubmittedSchedule,
  SucceededConduct,
  SucceededLoadSchedulingBoard,
  SucceededSchedule,
  UpdatedCampus,
  UpdatedMapLink,
  UpdatedMessage,
  UpdatedRoom,
  UpdatedScheduledAt,
} from "./message";
import { ConductData, init, type Model, type ReadyModel, LoadedSchedulingInput } from "./model";
import { updateFor } from "./update";
const decodeBoard = S.decodeUnknownSync(SchedulingBoard, { onExcessProperty: "error" });

const decodeResult = S.decodeUnknownSync(ScheduleInterviewResponse);

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

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
  coInterviewer: null,
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
  correctInterviewAssessment: () => Effect.die("not executed by transition tests"),
  },
};

const commands = commandsFor(inertClient);

const update = updateFor(commands);

type SchedulingUpdate = typeof update;

const ready = (model: Model): ReadyModel => {
  if (!Predicate.isTagged(model, "Ready")) throw new Error("expected a ready scheduling model");

  return model;
};

const initialModel = (): ReadyModel =>
  ready(
    init(
      LoadedSchedulingInput.make({ board: unscheduledBoard }),
      IdempotencyKey.make("scheduling-test-command"),
    ),
  );

const advance = (transition: SchedulingUpdate, model: Model, message: Message): ReadyModel =>
  ready(transition(model, message).model);

const conductDetail = S.decodeUnknownSync(RecruitmentInterviewConductObservationSchema)({
  interviewId: "recruitment-interview-50",
  applicationId: "recruitment-application-50",
  applicant: {
    applicantId: "recruitment-applicant-50",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  schedule: freshSchedule,
  invitationResponse: "Accepted",
  questions: [
    {
      interviewId: "recruitment-interview-50",
      questionId: "question-text",
      ordinal: 0,
      prompt: "Hva motiverer deg?",
      helpText: null,
      kind: "text",
      alternatives: [],
    },
  ],
  finalizedByPersonId: null,
  finalizedAt: null,
  answers: [{ questionId: "question-text", answer: "Original answer" }],
  score: null,
  recommendation: null,
  completionState: "NotCompleted",
  cancellationState: "NotCancelled",
  effectiveRevision: 1,
  history: [],
  cancelledAt: null,
  revision: 1,
  canFinalize: true,
  canCancel: true,
});

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
  it("retains a committed draft when cancellation hides its row and permits deliberate exit without another POST", async () => {
    let postCalls = 0;
    const hiddenBoard = decodeBoard({ departmentId: rawInterview.departmentId, interviews: [] });
    const client: RecruitmentClient = { recruitment: { ...inertClient.recruitment,
      scheduleInterview: () => Effect.sync(() => {
        postCalls += 1;
        return decodeResult({ interviewId: rawInterview.interviewId, schedule: freshSchedule, responseState: "Pending", notificationState: "Pending" });
      }),
      readSchedulingBoard: () => Effect.succeed(hiddenBoard),
    } };
    const transition = updateFor(commandsFor(client));
    const draft = validDraft(transition);
    const submitted = transition(draft, SubmittedSchedule());
    const committed = advance(transition, submitted.model, await Effect.runPromise(submitted.commands![0]!.effect));
    expect(committed.room.value).toBe(draft.room.value);
    expect(committed.scheduleDialog.isOpen).toBe(true);
    expect(transition(committed, SubmittedSchedule()).commands).toEqual([]);
    const refresh = transition(committed, RequestedBoardRefresh());
    const observed = advance(transition, refresh.model, await Effect.runPromise(refresh.commands![0]!.effect));
    expect(observed.room.value).toBe(draft.room.value);
    expect(transition(observed, SubmittedSchedule()).commands).toEqual([]);
    expect(postCalls).toBe(1);
    expect(advance(transition, observed, ClosedSchedule()).scheduleDialog.isOpen).toBe(false);
    expect(advance(transition, observed, GotScheduleDialogMessage({ message: Dialog.Message.RequestedClose() })).scheduleDialog.isOpen).toBe(false);
  });
  it("opens replacement only for RequestedNewTime and requires a fresh time selection", () => {
    for (const interview of responseBoard.interviews) {
      const board = decodeBoard({ ...responseBoard, interviews: [interview] });
      const initial = ready(init(LoadedSchedulingInput.make({ board }), IdempotencyKey.make("rebooking-gate-test-command")));
      const opened = advance(update, initial, OpenedSchedule({ interviewId: interview.interviewId }));
      if (interview.responseState !== "RequestedNewTime") {
        expect(opened).toBe(initial);
      } else {
        expect(opened.scheduleInterview?.responseMessage).toBe(interview.responseMessage);
        expect(opened.scheduledAt.value).toBe("");
        expect(update(opened, SubmittedSchedule()).commands).toEqual([]);
      }
    }
  });

  it("replays the exact uncertain command after a board refresh without accepting edits or duplicate submits", async () => {
    const calls: Array<Parameters<RecruitmentClient["recruitment"]["scheduleInterview"]>[0]> = [];
    const client: RecruitmentClient = { recruitment: { ...inertClient.recruitment,
      scheduleInterview: (input) => {
        calls.push(input);
        return Effect.fail(RecruitmentBridgeFailure.cases.Network.make({ message: "connection lost" }));
      },
    } };
    const transition = updateFor(commandsFor(client));
    const draft = validDraft(transition);
    const submitted = transition(draft, SubmittedSchedule());
    const failure = await Effect.runPromise(submitted.commands![0]!.effect);
    const failed = advance(transition, submitted.model, failure);
    const blockedEdit = advance(transition, failed, UpdatedRoom({ value: "Do not change replay" }));
    expect(blockedEdit.room.value).toBe(draft.room.value);
    const refresh = advance(transition, failed, RequestedBoardRefresh());
    const observed = advance(transition, refresh, SucceededLoadSchedulingBoard({ requestId: refresh.boardRequestId, board: freshBoard }));
    expect(observed.room.value).toBe(draft.room.value);
    const retry = transition(observed, SubmittedSchedule());
    await Effect.runPromise(retry.commands![0]!.effect);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(transition(retry.model, SubmittedSchedule()).commands).toEqual([]);
  });

  it("recovers a confirmed commit by reading without repeating the POST after a follow-up read conflict", async () => {
    const client: RecruitmentClient = { recruitment: { ...inertClient.recruitment,
      scheduleInterview: () => Effect.succeed(decodeResult({ interviewId: rawInterview.interviewId, schedule: freshSchedule, responseState: "Pending", notificationState: "Pending" })),
      readSchedulingBoard: () => Effect.fail(RecruitmentBridgeFailure.cases.Conflict.make({ message: "read failed" })),
    } };
    const transition = updateFor(commandsFor(client));
    const submitted = transition(validDraft(transition), SubmittedSchedule());
    const failed = advance(transition, submitted.model, await Effect.runPromise(submitted.commands![0]!.effect));
    const refresh = advance(transition, failed, RequestedBoardRefresh());
    const observed = advance(transition, refresh, SucceededLoadSchedulingBoard({ requestId: refresh.boardRequestId, board: freshBoard }));
    expect(failed.room.value).toBe(ready(submitted.model).room.value);
    expect(transition(failed, SubmittedSchedule()).commands).toEqual([]);
    expect(observed.scheduleDialog.isOpen).toBe(false);
    expect(observed.scheduleInterview).toBeNull();
    expect(transition(observed, SubmittedSchedule()).commands).toEqual([]);
  });

  it("keeps a stale replacement draft through failed refresh and adopts a new precondition only on explicit recovery", () => {
    const requested = responseBoard.interviews.find((interview) => interview.responseState === "RequestedNewTime")!;
    const board = decodeBoard({ ...responseBoard, interviews: [requested] });
    let draft = advance(update, ready(init(LoadedSchedulingInput.make({ board }), IdempotencyKey.make("rebooking-conflict-test-command"))), OpenedSchedule({ interviewId: requested.interviewId }));
    draft = advance(update, draft, UpdatedScheduledAt({ value: "2031-10-01T10:00:00Z" }));
    draft = advance(update, draft, UpdatedRoom({ value: "Replacement room" }));
    draft = advance(update, draft, UpdatedMessage({ value: "Replacement invitation" }));
    const submitted = advance(update, draft, SubmittedSchedule());
    const conflict = advance(update, submitted, FailedSchedule({ requestId: submitted.boardRequestId, failure: RecruitmentBridgeFailure.cases.Conflict.make({ message: "stale" }), outcome: "Rejected" }));
    expect(update(conflict, SubmittedSchedule()).commands).toEqual([]);
    const refreshing = advance(update, conflict, RequestedBoardRefresh());
    const failedRefresh = advance(update, refreshing, FailedLoadSchedulingBoard({ requestId: refreshing.boardRequestId, message: "offline" }));
    expect(failedRefresh.room.value).toBe("Replacement room");
    expect(update(failedRefresh, SubmittedSchedule()).commands).toEqual([]);
    const refresh = advance(update, failedRefresh, RequestedBoardRefresh());
    const newEtag = StrongETag.make('"vkr2.' + "B".repeat(43) + '"');
    const newer = decodeBoard({ ...board, interviews: [{ ...requested, revision: 3, etag: newEtag }] });
    const recovered = advance(update, refresh, SucceededLoadSchedulingBoard({ requestId: refresh.boardRequestId, board: newer }));
    const retry = advance(update, recovered, SubmittedSchedule());
    expect(retry.scheduleAttempt?.headers["if-match"]).toBe(newEtag);
    expect(retry.scheduleAttempt?.headers["idempotency-key"]).not.toBe(submitted.scheduleAttempt?.headers["idempotency-key"]);
    expect(retry.scheduleAttempt?.payload.room).toBe("Replacement room");
    const noLongerEligible = advance(update, refresh, SucceededLoadSchedulingBoard({ requestId: refresh.boardRequestId, board: freshBoard }));
    expect(noLongerEligible.room.value).toBe("Replacement room");
    expect(update(noLongerEligible, SubmittedSchedule()).commands).toEqual([]);
    const secondRefresh = advance(update, noLongerEligible, RequestedBoardRefresh());
    const nowEligible = advance(update, secondRefresh, SucceededLoadSchedulingBoard({ requestId: secondRefresh.boardRequestId, board: newer }));
    const nextCycle = advance(update, nowEligible, SubmittedSchedule());
    expect(nextCycle.scheduleAttempt?.headers["if-match"]).toBe(newEtag);
    expect(nextCycle.scheduleAttempt?.headers["idempotency-key"]).not.toBe(submitted.scheduleAttempt?.headers["idempotency-key"]);
    expect(nextCycle.scheduleAttempt?.payload.room).toBe("Replacement room");
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

    const { model: invalid, commands: emitted = [] } = update(opened, SubmittedSchedule());

    expect(ready(invalid).scheduledAt._tag).toBe("Invalid");
    expect(ready(invalid).room._tag).toBe("Invalid");
    expect(emitted).toEqual([]);
  });

  it("emits exactly one first submit and blocks a duplicate while pending", () => {
    const { model: pending, commands: emitted = [] } = update(validDraft(update), SubmittedSchedule());

    expect(ready(pending).isScheduling).toBe(true);
    expect(emitted).toHaveLength(1);

    const { model: unchanged, commands: duplicate = [] } = update(pending, SubmittedSchedule());
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
              interviewId: input.params.interviewId,
              schedule: postObservationSchedule,
              responseState: "Pending",
              notificationState: "Pending",
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
      correctInterviewAssessment: () => Effect.die("not executed by transition tests"),
      },
    };

    const flowUpdate = updateFor(commandsFor(client));
    const { model: pending, commands: emitted = [] } = flowUpdate(validDraft(flowUpdate), SubmittedSchedule());
    const pendingBoard = AsyncData.getData(ready(pending).board);

    expect(pendingBoard._tag).toBe("Some");

    if (!Predicate.isTagged(pendingBoard, "Some")) throw new Error("expected the initial board observation");
    expect(pendingBoard.value).toEqual(unscheduledBoard);

    const successMessage = await Effect.runPromise(emitted[0]!.effect);

    if (!Predicate.isTagged(successMessage, "SucceededSchedule")) {
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

    const { model: completed } = flowUpdate(pending, successMessage);
    const completedModel = ready(completed);
    const completedBoard = AsyncData.getData(completedModel.board);
    expect(completedBoard._tag).toBe("Some");

    if (!Predicate.isTagged(completedBoard, "Some")) throw new Error("expected the fresh board observation");
    expect(completedBoard.value).toEqual(freshBoard);
  });
  it("keeps a changed conduct draft when a concurrent board refresh returns an old body with a newer opaque ETag", () => {
    const current = {
      ...initialModel(),
      selectedInterviewId: conductDetail.interviewId,
      conduct: AsyncData.Success({ data: conductDetail }),
      conductEtag: etag,
      conductRequestId: 4,
      conductGeneration: 7,
      answers: [{ questionId: "question-text", answer: "Draft answer" }],
    } satisfies ReadyModel;

    const changed = advance(
      update,
      current,
      ChangedAnswer({ questionId: "question-text", answer: "Edited draft" }),
    );

    const { model: refreshingModel } = update(changed, RequestedBoardRefresh());
    const refreshing = ready(refreshingModel);
    const newerEtag = StrongETag.make(`"vkr2.${"B".repeat(43)}"`);

    const { model: unchanged, commands: effects = [] } = update(
      refreshing,
      SucceededConduct({
        requestId: refreshing.conductRequestId,
        generation: current.conductGeneration,
        interviewId: conductDetail.interviewId,
        detail: conductDetail,
        etag: newerEtag,
      }),
    );

    expect(unchanged).toBe(refreshing);
    expect(ready(unchanged).answers).toEqual([
      { questionId: "question-text", answer: "Edited draft" },
    ]);
    expect(ready(unchanged).conductEtag).toBe(etag);
    expect(effects).toEqual([]);
  });
  it("ignores every conduct draft edit while the successful detail is refreshing", () => {
    const refreshing = {
      ...ready({
        ...initialModel(),
        conduct: ConductData.Refreshing({ data: conductDetail }),
        conductEtag: etag,
        answers: [{ questionId: "question-text", answer: "Draft answer" }],
      }),
      isConducting: false,
    } satisfies ReadyModel;

    const messages = [
      ChangedAnswer({ questionId: "question-text", answer: "Edited answer" }),
      ChangedRecommendation({ value: "Kanskje" }),
      ChangedScore({ axis: "suitability", value: "9" }),
    ];

    for (const message of messages) {
      const { model: next, commands: effects = [] } = update(refreshing, message);
      expect(next).toBe(refreshing);
      expect(effects).toEqual([]);
    }
  });

  it("ignores stale load and schedule request observations", () => {
    const { model: pending } = update(validDraft(update), SubmittedSchedule());

    const current = {
      ...ready(pending),
      boardRequestId: ready(pending).boardRequestId + 1,
    };

    const staleRequestId = ready(pending).boardRequestId;

    const staleMessages = [
      SucceededLoadSchedulingBoard({ requestId: staleRequestId, board: freshBoard }),
      FailedLoadSchedulingBoard({ requestId: staleRequestId, message: "stale load" }),
      SucceededSchedule({ requestId: staleRequestId, board: freshBoard }),
      FailedSchedule({ requestId: staleRequestId, failure: RecruitmentBridgeFailure.cases.Network.make({ message: "stale" }), outcome: "Unknown" }),
    ];

    for (const message of staleMessages) {
      const { model: next, commands: emitted = [] } = update(current, message);
      expect(next).toBe(current);
      expect(emitted).toEqual([]);
    }
  });
});

describe("0101 explicit recommendation draft", () => {
  it("starts without an inferred recommendation and retains the whole draft on stale finalization", () => {
    const initial = initialModel();
    expect(initial.recommendation).toBeNull();
    const chosen = advance(update, initial, ChangedRecommendation({ value: "Kanskje" }));

    const draft = {
      ...chosen,
      selectedInterviewId: unscheduledBoard.interviews[0]!.interviewId,
      answers: [{ questionId: "question-1", answer: "My unchanged answer" }],
      isConducting: true,
      pendingConductAction: "Finalize" as const,
    };

    const { model: next, commands: effects = [] } = update(
      draft,
      FailedFinalize({
        requestId: draft.conductRequestId,
        generation: draft.conductGeneration,
        interviewId: unscheduledBoard.interviews[0]!.interviewId,
        failure: RecruitmentBridgeFailure.cases.Conflict.make({message: "Changed remotely"}),
      }),
    );

    const kept = ready(next);
    expect(kept.recommendation).toBe("Kanskje");
    expect(kept.answers).toEqual(draft.answers);
    expect(kept.score).toEqual(draft.score);
    expect(kept.conduct).toEqual(draft.conduct);
    expect(kept.isConducting).toBe(false);
    expect(effects).toEqual([]);
  });
});
