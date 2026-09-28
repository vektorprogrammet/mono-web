
import { Schema as S, flow } from "effect";
import { data } from "react-router";
import {
  contentBridgeFailure,
  type ContentBridgeErrorTag,
  ContentArticleObservationSchema,
  ContentBridgeActionSchema,
  ContentWorkspaceBootstrapSchema,
} from "../foldkit/content/bridge";
import { callNative } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { nativeFailureFrom } from "../lib/native-problem";
import type { Route } from "./+types/__foldkit.content";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const statusFor = (tag: ContentBridgeErrorTag): number => {
  switch (tag) {
    case "UnauthenticatedActor":
      return 401;
    case "AuthorityInactive":
    case "NotInScope":
    case "NotPublisher":
    case "DraftNotOwned":
      return 403;
    case "ArticleNotFound":
      return 404;
    case "SlugConflict":
    case "DepartmentNotFound":
    case "ContentDecodeError":
      return 422;
    case "CommandConflict":
      return 409;
    case "Network":
      return 502;
    case "ContentIntegrityError":
    case "ContentPersistenceError":
    case "Configuration":
      return 503;
  }
};

const tagFrom = flow(nativeFailureFrom, (error): ContentBridgeErrorTag => {
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }

  const code = error instanceof Error || error instanceof Response ? "" : error?.code ?? "";

  if (code === "credential.missing" || code === "credential.invalid") {
    return "UnauthenticatedActor";
  }

  if (code === "authority.denied") return "NotInScope";

  if (code === "resource.not-found" || code === "content.article-not-found") {
    return "ArticleNotFound";
  }

  if (code.includes("slug")) return "SlugConflict";

  if (code.includes("department")) return "DepartmentNotFound";

  if (code.startsWith("precondition.") || code.startsWith("idempotency.")) {
    return "CommandConflict";
  }

  if (code.startsWith("validation.") || code === "request.malformed") {
    return "ContentDecodeError";
  }

  if (code === "content.integrity-error" || code === "internal.error") {
    return "ContentIntegrityError";
  }

  if (code === "dependency.unavailable") return "Network";

  return "ContentPersistenceError";
});

/** The article and its entity tag, as the browser client reads them from the bridge. */
const articleObservation = (resource: {
  readonly article: typeof ContentArticleObservationSchema.Type["body"];
  readonly etag: typeof ContentArticleObservationSchema.Type["etag"];
}) => S.encodeSync(ContentArticleObservationSchema)({ body: resource.article, etag: resource.etag });

export async function loader({ request }: Route.LoaderArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);

    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  try {
    const [workspace, departments] = await Promise.all([
      callNative(cookie, request, (client) => client["content.readContentWorkspace"]({})),
      callNative(cookie, request, (client) => client["organization.listDepartments"]()),
    ]);

    return data(
      S.encodeSync(ContentWorkspaceBootstrapSchema)({
        workspace,
        knownDepartments: departments
          .filter((department) => department.active)
          .map(({ departmentId, name }) => ({ departmentId, name })),
      }),
      { headers: responseHeaders },
    );
  } catch (error) {
    const tag = tagFrom(error);

    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);

    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  let command: typeof ContentBridgeActionSchema.Type;

  try {
    command = S.decodeUnknownSync(ContentBridgeActionSchema)(
      await request.json().catch(() => null),
      { onExcessProperty: "error" },
    );
  } catch {
    return data(contentBridgeFailure("ContentDecodeError"), {
      status: 422,
      headers: responseHeaders,
    });
  }

  try {
    switch (command.operation) {
      case "readArticle": {
        const { articleId } = command;

        return data(
          articleObservation(
            await callNative(cookie, request, (client) =>
              client["content.readArticle"]({ articleId }),
            ),
          ),
          { headers: responseHeaders },
        );
      }

      case "createDraft": {
        const { operation: _, commandId, ...article } = command;

        return data(
          articleObservation(
            await callNative(cookie, request, (client) =>
              client["content.createArticle"]({
                idempotencyKey: commandId,
                request: article,
              }),
            ),
          ),
          { headers: responseHeaders },
        );
      }

      case "reviseDraft": {
        const { operation: _, commandId, articleId, etag, ...patch } = command;

        return data(
          articleObservation(
            await callNative(cookie, request, (client) =>
              client["content.reviseArticle"]({
                articleId,
                idempotencyKey: commandId,
                ifMatch: etag,
                request: patch,
              }),
            ),
          ),
          { headers: responseHeaders },
        );
      }

      case "publish":
      case "unpublish": {
        const { articleId, commandId, operation } = command;

        // The transition runs under the entity tag of the article as the server reads it now.
        const current = await callNative(cookie, request, (client) =>
          client["content.readArticle"]({ articleId }),
        );

        const transition = {
          articleId,
          idempotencyKey: commandId,
          ifMatch: current.etag,
        };

        await callNative(cookie, request, (client) =>
          operation === "publish"
            ? client["content.publishArticle"](transition)
            : client["content.unpublishArticle"](transition),
        );

        return data({}, { headers: responseHeaders });
      }
    }
  } catch (error) {
    const tag = tagFrom(error);

    return data(contentBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}
