import { Schema as S } from "effect";

export const SchoolsBridgeErrorTagSchema = S.Literals([
  "UnauthenticatedActor",
  "AuthorityInactive",
  "NotInScope",
  "SchoolsDepartmentNotFound",
  "SchoolsDepartmentOutOfScope",
  "SchoolsDecodeError",
  "SchoolsPersistenceError",
  "Network",
  "Configuration",
]);
export type SchoolsBridgeErrorTag = typeof SchoolsBridgeErrorTagSchema.Type;

export const SchoolsBridgeFailureSchema = S.Struct({
  error: S.Struct({ tag: SchoolsBridgeErrorTagSchema }),
});
export type SchoolsBridgeFailure = typeof SchoolsBridgeFailureSchema.Type;

export const schoolsBridgeFailure = (tag: SchoolsBridgeErrorTag): SchoolsBridgeFailure => ({
  error: { tag },
});
