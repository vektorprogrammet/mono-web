import { Dialog } from "@foldkit/ui";
import {
  IdempotencyKey,
  StrongETag,
  TeamApplicationCursor,
  TeamApplicationId,
  TeamApplicationIntakeMergePatch,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";

export const TeamId = TeamApplicationListResponse.fields.teamId;

export type TeamId = typeof TeamId.Type;

export type TeamApplicationIntake = (typeof TeamApplicationListResponse.Type)["intake"];

export const RequestId = S.Int.check(S.isGreaterThanOrEqualTo(0));

/** Read outcomes the workflow renders differently. */
export const ReadFailure = S.Literals(["Denied", "NotFound", "SessionExpired", "Unavailable"]);

export type ReadFailure = typeof ReadFailure.Type;

/** Mutation outcomes. Only `Unavailable` is ambiguous: the request may have committed. */
export const MutationFailure = S.Literals([
  "Stale",
  "Denied",
  "NotFound",
  "SessionExpired",
  "NoChange",
  "Rejected",
  "Unavailable",
]);

export type MutationFailure = typeof MutationFailure.Type;

export const PageData = AsyncData.Schema(TeamApplicationListResponse, ReadFailure);

export const DetailData = AsyncData.Schema(TeamApplicationResource, ReadFailure);

/** One mutation exactly as it is sent, including its idempotency key. */
export const MutationRequest = S.TaggedUnion({
  DeleteApplication: { applicationId: TeamApplicationId, commandId: IdempotencyKey },
  ReviseIntake: {
    etag: StrongETag,
    patch: TeamApplicationIntakeMergePatch,
    commandId: IdempotencyKey,
  },
});

export type MutationRequest = typeof MutationRequest.Type;

export const Mutation = S.TaggedUnion({
  Idle: {},
  Sending: { request: MutationRequest },
});

export const Notice = S.Literals([
  "Deleted",
  "IntakeSaved",
  "Stale",
  "Denied",
  "NotFound",
  "NoChange",
  "Rejected",
  "Unavailable",
  "SessionExpired",
]);

export type Notice = typeof Notice.Type;

/** Leader edits of the observed intake. `deadline` is a `datetime-local` value in Oslo time. */
export const IntakeDraft = S.Struct({
  basedOnEtag: StrongETag,
  acceptApplication: S.Boolean,
  deadline: S.String,
});

export type IntakeDraft = typeof IntakeDraft.Type;

export const Model = S.Struct({
  teamId: TeamId,
  page: PageData.schema,
  pageCursor: S.NullOr(TeamApplicationCursor),
  pageNumber: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  pageRequestId: RequestId,
  selectedApplicationId: S.NullOr(TeamApplicationId),
  detail: DetailData.schema,
  detailRequestId: RequestId,
  deleteDialog: Dialog.Model,
  intakeDraft: S.NullOr(IntakeDraft),
  mutation: Mutation,
  mutationRequestId: RequestId,
  uncertainRequest: S.NullOr(MutationRequest),
  idempotencyKeySeed: IdempotencyKey,
  commandSequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  notice: S.NullOr(Notice),
});

export type Model = typeof Model.Type;

/** Element ids shared by the view and the focus Commands. */
export const LIST_HEADING_ID = "team-applications-list-title";

export const DETAIL_HEADING_ID = "team-application-detail-title";

export const INTAKE_HEADING_ID = "team-applications-intake-title";

export const DEADLINE_INPUT_ID = "team-application-deadline";

export const init = (teamId: TeamId, idempotencyKeySeed: IdempotencyKey): Model => ({
  teamId,
  page: PageData.Loading(),
  pageCursor: null,
  pageNumber: 1,
  pageRequestId: 1,
  selectedApplicationId: null,
  detail: DetailData.Idle(),
  detailRequestId: 0,
  deleteDialog: Dialog.init({ id: "team-application-delete-dialog" }),
  intakeDraft: null,
  mutation: Mutation.cases.Idle.make({}),
  mutationRequestId: 0,
  uncertainRequest: null,
  idempotencyKeySeed,
  commandSequence: 0,
  notice: null,
});
