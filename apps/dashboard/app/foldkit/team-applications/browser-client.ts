import type {
  IdempotencyKey,
  StrongETag,
  TeamApplicationId,
  TeamApplicationIntakeMergePatch,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/http-api";
import { createEffectClient, type EffectSdk } from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";
import { nativeProblemFrom, type NativeProblemSummary } from "../../lib/native-problem";
import type { TeamId } from "./model";

/** A decoded native problem code, or `Transport` when no problem body could be decoded. */
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

const withFailureCode = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, TeamApplicationsFailure, R> =>
  Effect.mapError(effect, (cause) => nativeProblemFrom(cause)?.code ?? "Transport");

/** Adapts the generated SDK group; the browser entry supplies the same-origin client. */
export const teamApplicationsOperations = (
  client: EffectSdk["team-applications"],
): TeamApplicationsOperations => ({
  listApplications: ({ teamId, cursor }) =>
    client
      .listTeamApplications({ params: { teamId }, query: cursor === null ? {} : { cursor } })
      .pipe(
        Effect.map(({ body }) => body),
        withFailureCode,
      ),
  readApplication: ({ applicationId }) =>
    client.readTeamApplication({ params: { applicationId } }).pipe(
      Effect.map(({ body }) => body),
      withFailureCode,
    ),
  deleteApplication: ({ applicationId, commandId }) =>
    client
      .deleteTeamApplication({
        params: { applicationId },
        headers: { "idempotency-key": commandId },
      })
      .pipe(Effect.asVoid, withFailureCode),
  reviseIntake: ({ teamId, etag, patch, commandId }) =>
    client
      .reviseTeamApplicationIntake({
        params: { teamId },
        headers: { "idempotency-key": commandId, "if-match": etag },
        payload: patch,
      })
      .pipe(
        Effect.map(({ body }) => body),
        withFailureCode,
      ),
});

export const createBrowserTeamApplicationsClient = (): TeamApplicationsOperations =>
  teamApplicationsOperations(
    createEffectClient(
      resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin),
    )["team-applications"],
  );
