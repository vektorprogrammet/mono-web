import type { EffectSdk } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentBridgeFailure,
  RecruitmentBridgeOperationJson,
  toRecruitmentBridgeFailure,
  type RecruitmentBridgeOperation,
} from "./bridge";

export type RecruitmentClient = Readonly<{
  admin: Readonly<{
    recruitment: EffectSdk["admin"]["recruitment"];
  }>;
}>;

const bridgeRequest = <A>(
  operation: RecruitmentBridgeOperation,
  decode: (value: unknown) => A,
): Effect.Effect<A, RecruitmentBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/recruitment", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: S.encodeSync(RecruitmentBridgeOperationJson)(operation),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw S.decodeUnknownSync(RecruitmentBridgeFailure)(payload, {
          onExcessProperty: "error",
        });
      }
      return decode(payload);
    },
    catch: toRecruitmentBridgeFailure,
  });

export const createBrowserRecruitmentClient = (): RecruitmentClient => ({
  admin: {
    recruitment: {
      readAssignmentBoard: (query) =>
        bridgeRequest(
          { operation: "readAssignmentBoard", query },
          (value) =>
            S.decodeUnknownSync(RecruitmentAssignmentBoardSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
      assignApplicant: (command) =>
        bridgeRequest(
          { operation: "assignApplicant", command },
          (value) =>
            S.decodeUnknownSync(RecruitmentAssignmentResultSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
    },
  },
});
