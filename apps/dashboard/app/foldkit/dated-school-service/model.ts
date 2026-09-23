import { CoverageBoardResource, OwnCoverageResource, PlacementBoardResource } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";

export const Input = S.Struct({
  departmentId: S.String,
  semesterId: S.String,
  board: S.NullOr(PlacementBoardResource),
  coverage: S.NullOr(CoverageBoardResource),
  ownCoverage: S.NullOr(OwnCoverageResource),
});
export type Input = S.Schema.Type<typeof Input>;

export const Model = S.Struct({
  selectedCommitmentId: S.NullOr(S.String),
  input: Input,
  scheduleDate: S.String,
  startTime: S.String,
  endTime: S.String,
  decision: S.Literals(["CompleteService", "CancelService", "MarkUnfulfilledService"]),
  attendedPersonIds: S.Array(S.String),
  evidenceSource: S.String,
  reason: S.String,
  commandSeed: S.String,
});
export type Model = S.Schema.Type<typeof Model>;

export const makeInitialModel = (input: Input): Model => ({
  input,
  scheduleDate: "",
  selectedCommitmentId: null,
  startTime: "",
  endTime: "",
  decision: "CompleteService",
  attendedPersonIds: [],
  evidenceSource: "",
  reason: "",
  commandSeed: crypto.randomUUID(),
});
