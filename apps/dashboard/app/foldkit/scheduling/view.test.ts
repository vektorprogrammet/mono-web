import { Dialog } from "@foldkit/ui";
import { Predicate } from "effect";
import { RecruitmentInterviewConductObservationSchema } from "@vektorprogrammet/http-api"
import { IdempotencyKey, SchedulingBoard, StrongETag } from "@vektorprogrammet/http-api";
import { Scene } from "foldkit/test";
import { AsyncData, FieldValidation } from "foldkit";
import { Schema as S } from "effect";
import { describe, it } from "vitest";
import { commandsFor } from "./command";
import { createBrowserRecruitmentClient } from "../recruitment/browser-client";
import { ConductData, init, type ReadyModel, LoadedSchedulingInput } from "./model";
import { updateFor } from "./update";
import { view } from "./view";
import { OpenedSchedule } from "./message";

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);
const schedule = {
  interviewId: "interview-conduct-view",
  scheduledAt: "2031-09-14T13:00:00.000Z",
  room: "Rom 1",
  campus: "Gløshaugen",
  mapLink: null,
  message: "Vi sees.",
  scheduledByPersonId: "person-scheduler",
  committedAt: "2031-09-01T10:00:00.000Z",
  scheduleRevision: 1,
} as const;

type CoInterviewer = Readonly<{ personId: string; displayName: string }>;

const detailFor = (state: "Completed" | "Cancelled") =>
  S.decodeUnknownSync(RecruitmentInterviewConductObservationSchema)({
    interviewId: schedule.interviewId,
    applicationId: "application-conduct-view",
    applicant: {
      applicantId: "applicant-conduct-view",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    schedule,
    invitationResponse: "Accepted",
    questions: [
      {
        interviewId: schedule.interviewId,
        questionId: "question-text",
        ordinal: 0,
        prompt: "Hva motiverer deg?",
        helpText: null,
        kind: "text",
        alternatives: [],
      },
      {
        interviewId: schedule.interviewId,
        questionId: "question-check",
        ordinal: 1,
        prompt: "Velg egenskaper",
        helpText: null,
        kind: "check",
        alternatives: ["Nysgjerrig", "Samarbeidsvillig"],
      },
    ],
    answers: [
      { questionId: "question-text", answer: "Persisted answer" },
      { questionId: "question-check", answer: ["Nysgjerrig"] },
    ],
    score: state === "Completed" ? { explanatoryPower: 7, roleModel: 8, suitability: 9 } : null,
    recommendation: null,
    completionState: state === "Completed" ? "Completed" : "NotCompleted",
    cancellationState: state === "Cancelled" ? "Cancelled" : "NotCancelled",
    finalizedByPersonId: state === "Completed" ? "person-interviewer" : null,
    finalizedAt: state === "Completed" ? "2031-09-15T13:00:00.000Z" : null,
    history:
      state === "Completed"
        ? [
            {
              _tag: "Original" as const,
              revision: 2,
              answers: [
                { questionId: "question-text", answer: "Persisted answer" },
                { questionId: "question-check", answer: ["Nysgjerrig"] },
              ],
              score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
              recommendation: null,
              finalizedByPersonId: "person-interviewer",
              finalizedAt: "2031-09-15T13:00:00.000Z",
            },
          ]
        : [],
    effectiveRevision: 2,
    cancelledAt: state === "Cancelled" ? "2031-09-15T13:00:00.000Z" : null,
    revision: 2,
    canFinalize: false,
    canCancel: false,
  });

const terminalModel = (
  state: "Completed" | "Cancelled",
  coInterviewer: CoInterviewer | null = null,
): ReadyModel => {
  const detail = detailFor(state);

  const board = S.decodeUnknownSync(SchedulingBoard)({
    departmentId: "department-conduct-view",
    interviews: [
      {
        interviewId: detail.interviewId,
        applicationId: detail.applicationId,
        departmentId: "department-conduct-view",
        interviewer: {
          personId: "person-interviewer",
          displayName: "Interviewer",
          email: "interviewer@example.invalid",
          phone: "+4712345678",
        },
        coInterviewer,
        applicant: {
          applicationId: detail.applicationId,
          applicantId: detail.applicant.applicantId,
          firstName: detail.applicant.firstName,
          lastName: detail.applicant.lastName,
          email: "applicant@example.invalid",
          phone: "+4787654321",
        },
        revision: detail.revision,
        schedule,
        responseState: "Accepted",
        responseMessage: null,
        notificationState: "Delivered",
        etag,
      },
    ],
  });

  const initial = init(
    LoadedSchedulingInput.make({ board }),
    IdempotencyKey.make("conduct-view-test-command"),
  );

  const score =
    detail.score === null
      ? Predicate.isTagged(initial, "Ready")
        ? initial.score
        : undefined
      : {
          explanatoryPower: FieldValidation.NotValidated({
            value: String(detail.score.explanatoryPower),
          }),
          roleModel: FieldValidation.NotValidated({ value: String(detail.score.roleModel) }),
          suitability: FieldValidation.NotValidated({ value: String(detail.score.suitability) }),
        };

  if (!Predicate.isTagged(initial, "Ready") || score === undefined) throw new Error("expected ready model");

  const model: ReadyModel = {
    ...initial,
    selectedInterviewId: detail.interviewId,
    conduct: ConductData.Success({ data: detail }),
    answers: detail.answers,
    score,
  };

  return model;
};



const config = { update: updateFor(commandsFor(createBrowserRecruitmentClient())), view };

describe("Foldkit scheduling conduct view", () => {
  it("keeps a confirmed draft read-only while allowing explicit exit", () => {
    const source = terminalModel("Completed");
    const data = AsyncData.getData(source.board);
    if (!Predicate.isTagged(data, "Some")) throw new Error("expected board");
    const committed: ReadyModel = {
      ...source,
      conduct: ConductData.Idle(),
      scheduleInterview: data.value.interviews[0]!,
      scheduleCommitted: true,
      scheduleDialog: Dialog.open(source.scheduleDialog).model,
      room: FieldValidation.NotValidated({ value: "Retained replacement room" }),
    };
    Scene.scene(config, Scene.given(committed),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.label("Rom")).toHaveValue("Retained replacement room"),
      Scene.expect(Scene.label("Rom")).toBeDisabled(),
      Scene.expect(Scene.selector('dialog button[type="submit"]')).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Lukk og forkast utkast" })).toBeEnabled(),
    );
  });
  it("shows the requested-time context inside the replacement dialog without reusing the old time", () => {
    const source = terminalModel("Completed");
    const data = AsyncData.getData(source.board);
    if (!Predicate.isTagged(data, "Some")) throw new Error("expected board");
    const board = S.decodeUnknownSync(SchedulingBoard)({ ...data.value, interviews: data.value.interviews.map((interview) => ({
      ...interview, responseState: "RequestedNewTime", responseMessage: "Etter klokken fire, takk.",
    })) });
    const initial = init(LoadedSchedulingInput.make({ board }), IdempotencyKey.make("replacement-view-test-command"));
    const opened = config.update(initial, OpenedSchedule({ interviewId: board.interviews[0]!.interviewId })).model;
    Scene.scene(config, Scene.given(opened),
      Scene.Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
      Scene.expect(Scene.selector('dialog .fs-details')).toContainText("Etter klokken fire, takk."),
      Scene.expect(Scene.selector('dialog .fs-details')).toContainText(schedule.room),
      Scene.expect(Scene.label("Tidspunkt")).toHaveValue(""),
      Scene.expect(Scene.selector('dialog button[type="submit"]')).toBeEnabled(),
    );
  });
  it("permits correcting completed assessments while cancelled answers stay read-only", () => {
    Scene.scene(config, Scene.given(terminalModel("Completed")),
      Scene.expect(Scene.role("heading", {name: "Planlegg intervjuer"})).toBeVisible(),
      Scene.expect(Scene.selector("#question-question-text")).toHaveValue("Persisted answer"),
      Scene.expect(Scene.selector("#question-question-text")).toBeEnabled(),
      Scene.expect(Scene.selector("#score-explanatoryPower")).toHaveValue("7"),
      Scene.expect(Scene.selector("#score-roleModel")).toHaveValue("8"),
      Scene.expect(Scene.selector("#score-suitability")).toHaveValue("9"),
    );
    Scene.scene(config, Scene.given(terminalModel("Cancelled")),
      Scene.expect(Scene.selector("#question-question-text")).toBeDisabled(),
      Scene.expect(Scene.selector("#question-question-check-0")).toBeDisabled(),
      Scene.expect(Scene.selector("#question-question-check-1")).toBeDisabled(),
      Scene.expectAll(Scene.all.role("combobox")).toBeEmpty(),
    );
  });
  it("renders the co-interviewer from the board projection", () => {
    Scene.scene(config, Scene.given(terminalModel("Completed", {personId: "person-co-interviewer", displayName: "Cora Medintervjuer"})),
      Scene.expect(Scene.text("Medintervjuer: Cora Medintervjuer")).toBeVisible(),
    );
  });
  it("blocks conduct edits while a refreshed observation is pending", () => {
    Scene.scene(config, Scene.given({...terminalModel("Completed"), conduct: ConductData.Refreshing({data: detailFor("Completed")})}),
      Scene.expect(Scene.selector("#question-question-text")).toBeDisabled(),
      Scene.expect(Scene.selector("#score-explanatoryPower")).toBeDisabled(),
      Scene.expect(Scene.selector("#question-question-check-0")).toBeDisabled(),
    );
  });
  it("associates the native answer with its visible label and question legend", () => {
    Scene.scene(config, Scene.given(terminalModel("Completed")),
      Scene.expect(Scene.label("Svar")).toHaveId("question-question-text"),
      Scene.expect(Scene.selector("#question-question-text-legend")).toHaveText("1. Hva motiverer deg?"),
    );
  });
  it("shows stored checkbox answers without allowing cancelled interview edits", () => {
    Scene.scene(config, Scene.given(terminalModel("Cancelled")),
      Scene.expect(Scene.selector("#question-question-check-0")).toBeChecked(),
      Scene.expect(Scene.selector("#question-question-check-1")).not.toBeChecked(),
      Scene.expect(Scene.selector("#question-question-check-0")).toBeDisabled(),
      Scene.expect(Scene.selector("#question-question-check-1")).toBeDisabled(),
    );
  });
});
