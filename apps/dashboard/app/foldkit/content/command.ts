import type { InternalSdkError } from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
import type { ContentWorkspaceClient } from "./browser-client";
import {
  FailedCommand,
  FailedWorkspace,
  LoadedArticleDetail,
  LoadedWorkspace,
  SucceededSave,
  SucceededTransition,
} from "./message";
import type { ContentFailure } from "./model";
import type { WorkspaceCommandFactories } from "./update";

const failureFrom = (error: InternalSdkError): ContentFailure => {
  switch (error._tag) {
    case "UnauthenticatedActor":
      return {
        _tag: "Denied",
        tag: "UnauthenticatedActor",
        message: "Økten din er utløpt. Logg inn på nytt.",
      };
    case "AuthorityInactive":
      return {
        _tag: "Denied",
        tag: "AuthorityInactive",
        message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
      };
    case "NotInScope":
      return {
        _tag: "Denied",
        tag: "NotInScope",
        message: "Du har ikke tilgang til artikkeladministrasjon.",
      };
    case "NotPublisher":
      return {
        _tag: "Denied",
        tag: "NotPublisher",
        message: "Kun ledere og administratorer kan publisere, avpublisere eller endre reklame.",
      };
    case "DraftNotOwned":
      return {
        _tag: "Denied",
        tag: "DraftNotOwned",
        message: "Du kan bare redigere egne kladder.",
      };
    case "SlugConflict":
      return {
        _tag: "Failed",
        tag: "SlugConflict",
        message: "Lenkenavnet er allerede i bruk. Prøv et annet navn.",
      };
    case "CommandConflict":
      return {
        _tag: "Failed",
        tag: "CommandConflict",
        message: "Artikkelen er endret av andre samtidig. Last siden på nytt.",
      };
    case "ArticleNotFound":
      return {
        _tag: "Failed",
        tag: "ArticleNotFound",
        message: "Artikkelen finnes ikke lenger.",
      };
    case "DepartmentNotFound":
      return {
        _tag: "Failed",
        tag: "DepartmentNotFound",
        message: "En valgt avdeling finnes ikke lenger.",
      };
    case "ContentDecodeError":
      return {
        _tag: "Failed",
        tag: "ContentDecodeError",
        message: "Artikkeldataene hadde et ugyldig format.",
      };
    case "ContentIntegrityError":
      return {
        _tag: "Failed",
        tag: "ContentIntegrityError",
        message: "Artikkeldataene er midlertidig utilgjengelige.",
      };
    case "ContentPersistenceError":
      return {
        _tag: "Failed",
        tag: "ContentPersistenceError",
        message: "Artikkeladministrasjonen er midlertidig utilgjengelig.",
      };
    case "Network":
      return {
        _tag: "Failed",
        tag: "Network",
        message: "Nettverksforbindelsen til artikkeladministrasjonen feilet.",
      };
    case "Configuration":
      return {
        _tag: "Failed",
        tag: "Configuration",
        message: "Artikkeladministrasjonen er ikke konfigurert.",
      };
    default:
      return {
        _tag: "Failed",
        tag: "ContentPersistenceError",
        message: "Artikkeladministrasjonen er midlertidig utilgjengelig.",
      };
  }
};

export const makeContentWorkspaceCommands = (
  client: ContentWorkspaceClient,
): WorkspaceCommandFactories => ({
  LoadWorkspace: ({ requestId }) => ({
    name: "LoadContentWorkspace",
    args: { requestId },
    effect: client.admin.content.workspace().pipe(
      Effect.map(({ workspace, knownDepartments }) =>
        LoadedWorkspace({ requestId, workspace, knownDepartments }),
      ),
      Effect.catch((error) =>
        Effect.succeed(FailedWorkspace({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  LoadArticleDetail: ({ requestId, articleId }) => ({
    name: "LoadContentArticleDetail",
    args: { requestId, articleId },
    effect: client.admin.content.readArticle(articleId).pipe(
      Effect.map((detail) => LoadedArticleDetail({ requestId, detail })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  SubmitCreate: ({ requestId, commandId, title, bodyHtml, departmentIds, sticky }) => ({
    name: "SubmitContentCreate",
    args: { requestId },
    effect: client.admin.content
      .createDraft({ commandId, title, bodyHtml, departmentIds, sticky } as never)
      .pipe(
        Effect.map((draft) => SucceededSave({ requestId, draft })),
        Effect.catch((error) =>
          Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
        ),
      ),
  }),
  SubmitRevise: ({
    requestId,
    commandId,
    articleId,
    expectedRevision,
    title,
    bodyHtml,
    departmentIds,
    sticky,
  }) => ({
    name: "SubmitContentRevise",
    args: { requestId },
    effect: client.admin.content
      .reviseDraft({
        commandId,
        articleId,
        expectedRevision,
        title,
        bodyHtml,
        departmentIds,
        sticky,
      } as never)
      .pipe(
        Effect.map((draft) => SucceededSave({ requestId, draft })),
        Effect.catch((error) =>
          Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
        ),
      ),
  }),
  SubmitPublish: ({ requestId, commandId, articleId }) => ({
    name: "SubmitContentPublish",
    args: { requestId },
    effect: client.admin.content.publish({ commandId, articleId } as never).pipe(
      Effect.map(() => SucceededTransition({ requestId })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  SubmitUnpublish: ({ requestId, commandId, articleId }) => ({
    name: "SubmitContentUnpublish",
    args: { requestId },
    effect: client.admin.content.unpublish({ commandId, articleId } as never).pipe(
      Effect.map(() => SucceededTransition({ requestId })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
});

export { failureFrom };
