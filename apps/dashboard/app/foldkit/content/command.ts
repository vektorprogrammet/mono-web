import { IdempotencyKey } from "@vektorprogrammet/http-api";
import type { ContentBridgeFailure } from "./bridge";
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
import { ContentFailure } from "./model";
import type { WorkspaceCommandFactories } from "./update";

const failureFrom = (error: ContentBridgeFailure): ContentFailure => {
  switch (error.error.tag) {
    case "UnauthenticatedActor":
      return ContentFailure.cases.Denied.make({
        tag: "UnauthenticatedActor",
        message: "Økten din er utløpt. Logg inn på nytt.",
      });
    case "AuthorityInactive":
      return ContentFailure.cases.Denied.make({
        tag: "AuthorityInactive",
        message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
      });
    case "NotInScope":
      return ContentFailure.cases.Denied.make({
        tag: "NotInScope",
        message: "Du har ikke tilgang til artikkeladministrasjon.",
      });
    case "NotPublisher":
      return ContentFailure.cases.Denied.make({
        tag: "NotPublisher",
        message: "Kun ledere og administratorer kan publisere, avpublisere eller endre reklame.",
      });
    case "DraftNotOwned":
      return ContentFailure.cases.Denied.make({
        tag: "DraftNotOwned",
        message: "Du kan bare redigere egne kladder.",
      });
    case "SlugConflict":
      return ContentFailure.cases.Failed.make({
        tag: "SlugConflict",
        message: "Lenkenavnet er allerede i bruk. Prøv et annet navn.",
      });
    case "CommandConflict":
      return ContentFailure.cases.Failed.make({
        tag: "CommandConflict",
        message: "Artikkelen er endret av andre samtidig. Last siden på nytt.",
      });
    case "ArticleNotFound":
      return ContentFailure.cases.Failed.make({
        tag: "ArticleNotFound",
        message: "Artikkelen finnes ikke lenger.",
      });
    case "DepartmentNotFound":
      return ContentFailure.cases.Failed.make({
        tag: "DepartmentNotFound",
        message: "En valgt avdeling finnes ikke lenger.",
      });
    case "ContentDecodeError":
      return ContentFailure.cases.Failed.make({
        tag: "ContentDecodeError",
        message: "Artikkeldataene hadde et ugyldig format.",
      });
    case "ContentIntegrityError":
      return ContentFailure.cases.Failed.make({
        tag: "ContentIntegrityError",
        message: "Artikkeldataene er midlertidig utilgjengelige.",
      });
    case "ContentPersistenceError":
      return ContentFailure.cases.Failed.make({
        tag: "ContentPersistenceError",
        message: "Artikkeladministrasjonen er midlertidig utilgjengelig.",
      });
    case "Network":
      return ContentFailure.cases.Failed.make({
        tag: "Network",
        message: "Nettverksforbindelsen til artikkeladministrasjonen feilet.",
      });
    case "Configuration":
      return ContentFailure.cases.Failed.make({
        tag: "Configuration",
        message: "Artikkeladministrasjonen er ikke konfigurert.",
      });
    default:
      return ContentFailure.cases.Failed.make({
        tag: "ContentPersistenceError",
        message: "Artikkeladministrasjonen er midlertidig utilgjengelig.",
      });
  }
};

export const commandsFor = (
  client: ContentWorkspaceClient,
): WorkspaceCommandFactories => ({
  LoadWorkspace: ({ requestId }) => ({
    name: "LoadContentWorkspace",
    args: { requestId },
    effect: client.content.readContentWorkspace().pipe(
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
    effect: client.content.readArticle({ articleId }).pipe(
      Effect.map((observation) => LoadedArticleDetail({ requestId, observation })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  SubmitCreate: ({ requestId, commandId, title, bodyHtml, departmentIds, sticky }) => ({
    name: "SubmitContentCreate",
    args: { requestId },
    effect: client.content
      .createArticle({
        commandId: IdempotencyKey.make(commandId),
        title,
        bodyHtml,
        departmentIds,
        sticky,
      })
      .pipe(
        Effect.map((observation) => SucceededSave({ requestId, observation })),
        Effect.catch((error) =>
          Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
        ),
      ),
  }),
  SubmitRevise: ({
    requestId,
    commandId,
    articleId,
    expectedEtag,
    title,
    bodyHtml,
    departmentIds,
    sticky,
  }) => ({
    name: "SubmitContentRevise",
    args: { requestId },
    effect: client.content
      .reviseArticle({
        commandId: IdempotencyKey.make(commandId),
        articleId,
        etag: expectedEtag,
        title,
        bodyHtml,
        departmentIds,
        sticky,
      })
      .pipe(
        Effect.map((observation) => SucceededSave({ requestId, observation })),
        Effect.catch((error) =>
          Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
        ),
      ),
  }),
  SubmitPublish: ({ requestId, commandId, articleId }) => ({
    name: "SubmitContentPublish",
    args: { requestId },
    effect: client.content
      .publishArticle({ commandId: IdempotencyKey.make(commandId), articleId })
      .pipe(
        Effect.map(() => SucceededTransition({ requestId })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  SubmitUnpublish: ({ requestId, commandId, articleId }) => ({
    name: "SubmitContentUnpublish",
    args: { requestId },
    effect: client.content
      .unpublishArticle({ commandId: IdempotencyKey.make(commandId), articleId })
      .pipe(
        Effect.map(() => SucceededTransition({ requestId })),
      Effect.catch((error) =>
        Effect.succeed(FailedCommand({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
});

export { failureFrom };
