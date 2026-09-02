import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { IdempotencyKey, StrongETag } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import {
  RecruitmentBridgeFailure,
  RecruitmentInterviewConductObservationSchema,
  SchedulingBoard,
} from "../recruitment/bridge";

const LoadedSchedulingInput = S.Struct({
  _tag: S.Literal("Loaded"),
  board: SchedulingBoard,
});

const FailedSchedulingInput = S.Struct({
  _tag: S.Literal("Failed"),
  message: S.String,
});

export const SchedulingInput = S.Union([LoadedSchedulingInput, FailedSchedulingInput]);
export type SchedulingInput = S.Schema.Type<typeof SchedulingInput>;
export const SchedulingInputJson = S.fromJsonString(SchedulingInput);

export const SchedulingBoardData = AsyncData.Schema(SchedulingBoard, S.String);
export const ConductData = AsyncData.Schema(
  RecruitmentInterviewConductObservationSchema,
  RecruitmentBridgeFailure,
);
export const SchedulingRequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));
export const ConductRequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));

const CommandSequence = S.Int.check(S.isGreaterThanOrEqualTo(0));
const StringField = FieldValidation.Field(S.String);
const ConductAnswer = S.Struct({
  questionId: S.String,
  answer: S.Union([S.String, S.Array(S.String)]),
});
const AnswerError = S.Struct({ questionId: S.String, message: S.String });
const ScoreDraft = S.Struct({
  explanatoryPower: StringField,
  roleModel: StringField,
  suitability: StringField,
});
const ConductAction = S.Literals(["Finalize", "Cancel"]);

const ReadyModel = S.Struct({
  _tag: S.Literal("Ready"),
  board: SchedulingBoardData.schema,
  boardRequestId: SchedulingRequestId,
  selectedInterviewId: S.NullOr(RecruitmentInterviewId),
  conduct: ConductData.schema,
  conductEtag: S.NullOr(StrongETag),
  conductRequestId: ConductRequestId,
  conductGeneration: ConductRequestId,
  conductDialog: Dialog.Model,
  pendingConductAction: S.NullOr(ConductAction),
  answers: S.Array(ConductAnswer),
  answerErrors: S.Array(AnswerError),
  score: ScoreDraft,
  conductValidationFeedback: S.NullOr(S.String),
  conductFeedback: S.NullOr(RecruitmentBridgeFailure),
  isConducting: S.Boolean,
  scheduleDialog: Dialog.Model,
  scheduledAt: StringField,
  room: StringField,
  campus: StringField,
  mapLink: StringField,
  message: StringField,
  isScheduling: S.Boolean,
  scheduleError: S.NullOr(S.String),
  feedback: S.NullOr(S.String),
  idempotencyKeySeed: IdempotencyKey,
  commandSequence: CommandSequence,
});

const InvalidInputModel = S.Struct({
  _tag: S.Literal("InvalidInput"),
});

export const Model = S.Union([ReadyModel, InvalidInputModel]);
export type Model = S.Schema.Type<typeof Model>;
export type ReadyModel = S.Schema.Type<typeof ReadyModel>;

export const makeInitialModel = (
  input: SchedulingInput,
  idempotencyKeySeed: typeof IdempotencyKey.Type,
): Model => ({
  _tag: "Ready",
  board:
    input._tag === "Loaded"
      ? SchedulingBoardData.Success({ data: input.board })
      : SchedulingBoardData.Failure({ error: input.message }),
  boardRequestId: 0,
  selectedInterviewId: null,
  conduct: ConductData.Idle(),
  conductEtag: null,
  conductRequestId: 0,
  conductGeneration: 0,
  conductDialog: Dialog.init({ id: "recruitment-conduct-dialog" }),
  pendingConductAction: null,
  answers: [],
  answerErrors: [],
  score: {
    explanatoryPower: FieldValidation.NotValidated({ value: "" }),
    roleModel: FieldValidation.NotValidated({ value: "" }),
    suitability: FieldValidation.NotValidated({ value: "" }),
  },
  conductValidationFeedback: null,
  conductFeedback: null,
  isConducting: false,
  scheduleDialog: Dialog.init({ id: "recruitment-scheduling-dialog" }),
  scheduledAt: FieldValidation.NotValidated({ value: "" }),
  room: FieldValidation.NotValidated({ value: "" }),
  campus: FieldValidation.NotValidated({ value: "" }),
  mapLink: FieldValidation.NotValidated({ value: "" }),
  message: FieldValidation.NotValidated({ value: "" }),
  isScheduling: false,
  scheduleError: null,
  feedback: null,
  idempotencyKeySeed,
  commandSequence: 0,
});

export const makeInvalidInputModel = (): Model => ({ _tag: "InvalidInput" });
