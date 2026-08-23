import { RecruitmentInterviewId } from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import { RecruitmentSchedulingBoardSchema } from "../recruitment/bridge";

const LoadedSchedulingInput = S.Struct({
  _tag: S.Literal("Loaded"),
  board: RecruitmentSchedulingBoardSchema,
});

const FailedSchedulingInput = S.Struct({
  _tag: S.Literal("Failed"),
  message: S.String,
});

export const SchedulingInput = S.Union([LoadedSchedulingInput, FailedSchedulingInput]);
export type SchedulingInput = S.Schema.Type<typeof SchedulingInput>;
export const SchedulingInputJson = S.fromJsonString(SchedulingInput);

export const SchedulingBoardData = AsyncData.Schema(RecruitmentSchedulingBoardSchema, S.String);
export const SchedulingRequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));

const CommandSequence = S.Int.check(S.isGreaterThanOrEqualTo(0));
const StringField = FieldValidation.Field(S.String);

const ReadyModel = S.Struct({
  _tag: S.Literal("Ready"),
  board: SchedulingBoardData.schema,
  boardRequestId: SchedulingRequestId,
  selectedInterviewId: S.NullOr(RecruitmentInterviewId),
  scheduleDialog: Dialog.Model,
  scheduledAt: StringField,
  room: StringField,
  campus: StringField,
  mapLink: StringField,
  message: StringField,
  isScheduling: S.Boolean,
  scheduleError: S.NullOr(S.String),
  feedback: S.NullOr(S.String),
  commandIdSeed: S.NonEmptyString,
  commandSequence: CommandSequence,
});

const InvalidInputModel = S.Struct({
  _tag: S.Literal("InvalidInput"),
});

export const Model = S.Union([ReadyModel, InvalidInputModel]);
export type Model = S.Schema.Type<typeof Model>;
export type ReadyModel = S.Schema.Type<typeof ReadyModel>;

export const makeInitialModel = (input: SchedulingInput, commandIdSeed: string): Model => ({
  _tag: "Ready",
  board:
    input._tag === "Loaded"
      ? SchedulingBoardData.Success({ data: input.board })
      : SchedulingBoardData.Failure({ error: input.message }),
  boardRequestId: 0,
  selectedInterviewId: null,
  scheduleDialog: Dialog.init({ id: "recruitment-scheduling-dialog" }),
  scheduledAt: FieldValidation.NotValidated({ value: "" }),
  room: FieldValidation.NotValidated({ value: "" }),
  campus: FieldValidation.NotValidated({ value: "" }),
  mapLink: FieldValidation.NotValidated({ value: "" }),
  message: FieldValidation.NotValidated({ value: "" }),
  isScheduling: false,
  scheduleError: null,
  feedback: null,
  commandIdSeed,
  commandSequence: 0,
});

export const makeInvalidInputModel = (): Model => ({ _tag: "InvalidInput" });
