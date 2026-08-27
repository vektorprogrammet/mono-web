import { RecruitmentInterviewConductObservationSchema } from "@vektorprogrammet/sdk";
import { RecruitmentSchedulingBoardSchema } from "@vektorprogrammet/sdk/effect";
import type { HtmlBuilder } from "foldkit/html";
import { FieldValidation } from "foldkit";
import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import type { Message } from "./message";
import { ConductData, makeInitialModel, type Model, type ReadyModel } from "./model";
import { view } from "./view";

interface RenderedAttribute {
  readonly name: string;
  readonly values: ReadonlyArray<unknown>;
}

interface RenderedNode {
  readonly tag: string;
  readonly attributes: ReadonlyArray<RenderedAttribute>;
  readonly children: ReadonlyArray<RenderedNode | string>;
}

const renderedNode = (tag: string, args: ReadonlyArray<unknown>): RenderedNode => ({
  tag,
  attributes: Array.isArray(args[0]) ? (args[0] as ReadonlyArray<RenderedAttribute>) : [],
  children: Array.isArray(args[1]) ? (args[1] as ReadonlyArray<RenderedNode | string>) : [],
});

const htmlBuilder = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "empty") return renderedNode("empty", []);
      if (property === "submodel") return () => renderedNode("empty", []);
      const name = String(property);
      return (...args: ReadonlyArray<unknown>) =>
        /^[A-Z]/.test(name) ? { name, values: args } : renderedNode(name, args);
    },
  },
) as HtmlBuilder<Message>;

const descendants = (node: RenderedNode): ReadonlyArray<RenderedNode> => [
  node,
  ...node.children.flatMap((child) => (typeof child === "string" ? [] : descendants(child))),
];

const textContent = (node: RenderedNode): string =>
  node.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");

const hasAttribute = (node: RenderedNode, name: string, value: unknown): boolean =>
  node.attributes.some(
    (attribute) => attribute.name === name && attribute.values.some((entry) => entry === value),
  );

const attribute = (node: RenderedNode, name: string): unknown =>
  node.attributes.find((candidate) => candidate.name === name)?.values[0];

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
    completionState: state === "Completed" ? "Completed" : "NotCompleted",
    cancellationState: state === "Cancelled" ? "Cancelled" : "NotCancelled",
    finalizedAt: state === "Completed" ? "2031-09-15T13:00:00.000Z" : null,
    cancelledAt: state === "Cancelled" ? "2031-09-15T13:00:00.000Z" : null,
    revision: 2,
    canFinalize: false,
    canCancel: false,
  });

const terminalModel = (state: "Completed" | "Cancelled"): Model => {
  const detail = detailFor(state);
  const board = S.decodeUnknownSync(RecruitmentSchedulingBoardSchema)({
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
      },
    ],
  });
  const initial = makeInitialModel({ _tag: "Loaded", board }, "conduct-view-test");
  const score =
    detail.score === null
      ? initial._tag === "Ready"
        ? initial.score
        : undefined
      : {
          explanatoryPower: FieldValidation.NotValidated({
            value: String(detail.score.explanatoryPower),
          }),
          roleModel: FieldValidation.NotValidated({ value: String(detail.score.roleModel) }),
          suitability: FieldValidation.NotValidated({ value: String(detail.score.suitability) }),
        };
  if (initial._tag !== "Ready" || score === undefined) throw new Error("expected ready model");
  const model: ReadyModel = {
    ...initial,
    selectedInterviewId: detail.interviewId,
    conduct: ConductData.Success({ data: detail }),
    answers: detail.answers,
    score,
  };
  return model;
};

describe("Foldkit scheduling conduct view", () => {
  it("keeps the scheduling heading and makes terminal answers and stored score read-only", () => {
    const completed = view(terminalModel("Completed"), htmlBuilder) as unknown as RenderedNode;
    const completedNodes = descendants(completed);
    const completedHeading = completedNodes.find(
      (node) => node.tag === "h1" && hasAttribute(node, "Id", "fs-page-title"),
    );
    expect(completedHeading && textContent(completedHeading)).toBe("Planlegg intervjuer");
    expect(completedNodes.some((node) => attribute(node, "Value") === "Persisted answer")).toBe(
      true,
    );

    const completedControls = completedNodes.filter((node) =>
      ["textarea", "input", "select"].includes(node.tag),
    );
    expect(completedControls).toHaveLength(6);
    expect(completedControls.every((node) => hasAttribute(node, "Disabled", true))).toBe(true);
    expect(
      completedNodes
        .filter((node) => node.tag === "select")
        .map((node) => attribute(node, "Value")),
    ).toEqual(["7", "8", "9"]);

    const cancelled = view(terminalModel("Cancelled"), htmlBuilder) as unknown as RenderedNode;
    const cancelledNodes = descendants(cancelled);
    const cancelledControls = cancelledNodes.filter((node) =>
      ["textarea", "input"].includes(node.tag),
    );
    expect(cancelledControls).toHaveLength(3);
    expect(cancelledControls.every((node) => hasAttribute(node, "Disabled", true))).toBe(true);
    expect(cancelledNodes.some((node) => node.tag === "select")).toBe(false);
  });
});
