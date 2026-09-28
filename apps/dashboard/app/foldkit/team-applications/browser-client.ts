import type {
  IdempotencyKey,
  NativeRpcClient,
  StrongETag,
  TeamApplicationId,
  TeamApplicationIntakeMergePatch,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/rpc";
import { Effect } from "effect";
import { callBrowserNative, type NativeAnswerInvalid } from "../../lib/browser-native";
import { nativeProblemFrom, type NativeProblemSummary } from "../../lib/native-problem";
import type { TeamId } from "./model";

/** A decoded native problem code, or `Transport` when the call ended without a problem. */
export type TeamApplicationsFailure = NativeProblemSummary["code"] | "Transport";

export interface TeamApplicationsOperations {
  readonly listApplications: (request: {
    readonly teamId: TeamId;
    readonly cursor: string | null;
  }) => Effect.Effect<typeof TeamApplicationListResponse.Type, TeamApplicationsFailure>;
  readonly readApplication: (request: {
    readonly applicationId: TeamApplicationId;
  }) => Effect.Effect<typeof TeamApplicationResource.Type, TeamApplicationsFailure>;
  readonly deleteApplication: (request: {
    readonly applicationId: TeamApplicationId;
    readonly commandId: IdempotencyKey;
  }) => Effect.Effect<void, TeamApplicationsFailure>;
  readonly reviseIntake: (request: {
    readonly teamId: TeamId;
    readonly etag: StrongETag;
    readonly patch: TeamApplicationIntakeMergePatch;
    readonly commandId: IdempotencyKey;
  }) => Effect.Effect<typeof TeamApplicationIntakeResource.Type, TeamApplicationsFailure>;
}

type NativeClient = NativeRpcClient["Service"];

/** Calls one native RPC: `callBrowserNative` in the browser, a recording client in tests. */
export type NativeCall = <A, E>(
  call: (client: NativeClient) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | NativeAnswerInvalid>;

const withFailureCode = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, TeamApplicationsFailure, R> =>
  Effect.mapError(effect, (cause) => nativeProblemFrom(cause)?.code ?? "Transport");

/** Adapts the team-application RPCs to the operations that the Foldkit commands run. */
export const teamApplicationsOperations = (call: NativeCall): TeamApplicationsOperations => ({
  listApplications: ({ teamId, cursor }) =>
    call((client) =>
      client["team-applications.listTeamApplications"](
        cursor === null ? { teamId } : { teamId, cursor },
      ),
    ).pipe(withFailureCode),
  readApplication: ({ applicationId }) =>
    call((client) => client["team-applications.readTeamApplication"]({ applicationId })).pipe(
      withFailureCode,
    ),
  deleteApplication: ({ applicationId, commandId }) =>
    call((client) =>
      client["team-applications.deleteTeamApplication"]({
        applicationId,
        idempotencyKey: commandId,
      }),
    ).pipe(withFailureCode),
  reviseIntake: ({ teamId, etag, patch, commandId }) =>
    call((client) =>
      client["team-applications.reviseTeamApplicationIntake"]({
        teamId,
        idempotencyKey: commandId,
        ifMatch: etag,
        request: patch,
      }),
    ).pipe(withFailureCode),
});

export const createBrowserTeamApplicationsClient = (): TeamApplicationsOperations =>
  teamApplicationsOperations(callBrowserNative);
