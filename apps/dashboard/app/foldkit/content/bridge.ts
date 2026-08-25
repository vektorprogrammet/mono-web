import { Schema as S } from "effect";

export const ContentBridgeErrorTagSchema = S.Literals([
  "UnauthenticatedActor",
  "AuthorityInactive",
  "NotInScope",
  "NotPublisher",
  "DraftNotOwned",
  "SlugConflict",
  "CommandConflict",
  "ArticleNotFound",
  "ContentDecodeError",
  "ContentIntegrityError",
  "ContentPersistenceError",
  "DepartmentNotFound",
  "Network",
  "Configuration",
]);
export type ContentBridgeErrorTag = typeof ContentBridgeErrorTagSchema.Type;

export const ContentBridgeFailureSchema = S.Struct({
  error: S.Struct({ tag: ContentBridgeErrorTagSchema }),
});
export type ContentBridgeFailure = typeof ContentBridgeFailureSchema.Type;

export const contentBridgeFailure = (tag: ContentBridgeErrorTag): ContentBridgeFailure => ({
  error: { tag },
});
