import { Effect, Schema } from "effect";
import type { InternalSdkError } from "../../errors.js";
import { ContentDecodeError } from "../../errors.js";
import {
  ContentWorkspaceSchema,
  CreateContentDraftCommandSchema,
  PublicationTransitionCommandSchema,
  ReviseContentDraftCommandSchema,
  type AdminContentWorkspaceInput,
  type CreateContentDraftCommand,
  type PublicationTransitionCommand,
  type ReviseContentDraftCommand,
} from "../../schemas/content.js";
import type { Transport } from "../../transport.js";

const strictContent = {
  strict: true,
  decodeError: () => new ContentDecodeError(),
  errorFamily: "content",
} as const;

const ObservationSchema = Schema.Struct({});

export interface AdminContentDomain {
  /** Reads the caller-visible workspace in exactly one native request. */
  readonly workspace: (
    input?: AdminContentWorkspaceInput,
  ) => Effect.Effect<typeof ContentWorkspaceSchema.Type, InternalSdkError>;
  readonly createDraft: (
    command: CreateContentDraftCommand,
  ) => Effect.Effect<Record<string, unknown>, InternalSdkError>;
  readonly reviseDraft: (
    command: ReviseContentDraftCommand,
  ) => Effect.Effect<Record<string, unknown>, InternalSdkError>;
  readonly publish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<Record<string, unknown>, InternalSdkError>;
  readonly unpublish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<Record<string, unknown>, InternalSdkError>;
}

export const createAdminContentDomain = (transport: Transport): AdminContentDomain => ({
  workspace: (input = {}) =>
    transport.get(
      "/api/admin/content/workspace",
      ContentWorkspaceSchema,
      input.department === undefined ? undefined : { department: input.department },
      strictContent,
    ),
  createDraft: (command) =>
    transport.post(
      "/api/admin/content/drafts",
      Schema.encodeSync(CreateContentDraftCommandSchema)(command),
      ObservationSchema as never,
      { ...strictContent, expectedStatus: 201 },
    ),
  reviseDraft: (command) =>
    transport.put(
      `/api/admin/content/drafts/${command.articleId}`,
      Schema.encodeSync(ReviseContentDraftCommandSchema)(command),
      ObservationSchema as never,
      strictContent,
    ),
  publish: (command) =>
    transport.post(
      `/api/admin/content/drafts/${command.articleId}/publish`,
      Schema.encodeSync(PublicationTransitionCommandSchema)(command),
      ObservationSchema as never,
      strictContent,
    ),
  unpublish: (command) =>
    transport.post(
      `/api/admin/content/drafts/${command.articleId}/unpublish`,
      Schema.encodeSync(PublicationTransitionCommandSchema)(command),
      ObservationSchema as never,
      strictContent,
    ),
});
