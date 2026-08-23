import {
  InterviewSchemaId,
  RecruitmentApplicationId,
  RecruitmentPersonId,
} from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import { RecruitmentAssignmentBoardSchema, RecruitmentBoardStatus } from "./bridge";

const LoadedRecruitmentInput = S.Struct({
  _tag: S.Literal("Loaded"),
  status: RecruitmentBoardStatus,
  board: RecruitmentAssignmentBoardSchema,
});

const FailedRecruitmentInput = S.Struct({
  _tag: S.Literal("Failed"),
  status: RecruitmentBoardStatus,
  message: S.String,
});

export const RecruitmentInput = S.Union([LoadedRecruitmentInput, FailedRecruitmentInput]);
export type RecruitmentInput = S.Schema.Type<typeof RecruitmentInput>;
export const RecruitmentInputJson = S.fromJsonString(RecruitmentInput);

export const AssignmentBoardData = AsyncData.Schema(RecruitmentAssignmentBoardSchema, S.String);

const CommandSequence = S.Int.check(S.isGreaterThanOrEqualTo(0));


const ReadyModel = S.Struct({
  _tag: S.Literal("Ready"),
  board: AssignmentBoardData.schema,
  selectedFilter: RecruitmentBoardStatus,
  selectedApplicationId: S.NullOr(RecruitmentApplicationId),
  selectedInterviewerPersonId: S.NullOr(RecruitmentPersonId),
  selectedInterviewSchemaId: S.NullOr(InterviewSchemaId),
  assignmentDialog: Dialog.Model,
  isAssigning: S.Boolean,
  assignmentError: S.NullOr(S.String),
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

export const makeInitialModel = (input: RecruitmentInput, commandIdSeed: string): Model => ({
  _tag: "Ready",
  board:
    input._tag === "Loaded"
      ? AssignmentBoardData.Success({ data: input.board })
      : AssignmentBoardData.Failure({ error: input.message }),
  selectedFilter: input.status,
  selectedApplicationId: null,
  selectedInterviewerPersonId: null,
  selectedInterviewSchemaId: null,
  assignmentDialog: Dialog.init({ id: "recruitment-assignment-dialog" }),
  isAssigning: false,
  assignmentError: null,
  feedback: null,
  commandIdSeed,
  commandSequence: 0,
});

export const makeInvalidInputModel = (): Model => ({ _tag: "InvalidInput" });
