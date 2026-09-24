import { nativeFailureFrom } from "../lib/native-problem";
import { Schema as S, flow } from "effect";
import { schoolSurveyResultsCsvContentDisposition } from "@vektorprogrammet/http-api";

import { data } from "react-router";
import {
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyResultsResource,
  SchoolSurveysBridgeOperation,
  SurveyId,
  schoolSurveysBridgeFailure,
  type SchoolSurveysBridgeErrorTag,
} from "../foldkit/surveys/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.surveys";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const statusFor = (tag: SchoolSurveysBridgeErrorTag): number => {
  switch (tag) {
    case "UnauthenticatedActor":
      return 401;
    case "NotInScope":
      return 403;
    case "SurveyNotFound":
      return 404;
    case "ValidationFailed":
    case "SurveyDecodeError":
      return 422;
    case "CommandConflict":
      return 409;
    case "Network":
      return 502;
    case "SurveyPersistenceError":
    case "Configuration":
      return 503;
  }
};

const tagFrom = flow(nativeFailureFrom, (error): SchoolSurveysBridgeErrorTag => {
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }

  const code = error instanceof Error || error instanceof Response ? "" : error?.code ?? "";

  if (code === "credential.missing" || code === "credential.invalid") {
    return "UnauthenticatedActor";
  }

  if (code === "authority.denied" || code === "origin.denied") return "NotInScope";

  if (code === "resource.not-found") return "SurveyNotFound";

  if (code.startsWith("idempotency.") || code.startsWith("precondition.")) {
    return "CommandConflict";
  }

  if (
    code === "validation.failed" ||
    code === "request.malformed" ||
    code === "header.malformed" ||
    code === "request.too-large" ||
    code === "scope.invalid" ||
    code === "media-type.unsupported"
  ) {
    return "ValidationFailed";
  }

  if (code === "dependency.unavailable" || code === "organization.unavailable") return "Network";

  if (code === "") return "SurveyPersistenceError";

  return "SurveyPersistenceError";
});

const failure = (tag: SchoolSurveysBridgeErrorTag) =>
  data(schoolSurveysBridgeFailure(tag), {
    status: statusFor(tag),
    headers: responseHeaders,
  });

type SchoolSurveyCsvHeaders = {
  readonly "cache-control"?: unknown;
  readonly "content-disposition"?: unknown;
  readonly "content-type"?: unknown;
  readonly vary?: unknown;
};

const csvResponse = (
  surveyId: S.Schema.Type<typeof SurveyId>,
  body: string,
  sourceHeaders: SchoolSurveyCsvHeaders,
): Response => {
  const cacheControl = sourceHeaders["cache-control"];
  const contentDisposition = sourceHeaders["content-disposition"];
  const contentType = sourceHeaders["content-type"];
  const vary = sourceHeaders.vary;
  const expectedDisposition = schoolSurveyResultsCsvContentDisposition(surveyId);

  if (
    cacheControl !== "private, no-store" ||
    contentDisposition !== expectedDisposition ||
    contentType !== "text/csv; charset=utf-8" ||
    vary !== "Origin"
  ) {
    throw new Error("School-survey CSV response did not satisfy its transport contract");
  }

  return new Response(body, {
    headers: {
      ...responseHeaders,
      "Cache-Control": cacheControl,
      "Content-Disposition": contentDisposition,
      "Content-Type": contentType,
      Vary: vary,
    },
  });
};

export async function loader({ request }: Route.LoaderArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    return failure(tagFrom(error));
  }

  const exportValue = new URL(request.url).searchParams.get("export");

  try {
    const surveys = createAuthenticatedClient(cookie, request).surveys;

    if (exportValue !== null) {
      let surveyId: S.Schema.Type<typeof SurveyId>;

      try {
        surveyId = S.decodeUnknownSync(SurveyId)(exportValue);
      } catch {
        return failure("SurveyDecodeError");
      }

      const result = await surveys.exportAdminResults({ params: { surveyId } });

      if (result.body === undefined) {
        throw new Error("School-survey CSV response did not include a body");
      }

      return csvResponse(surveyId, result.body, result.headers);
    }

    const result = await surveys.readAdminCatalog();

    if (result.body === undefined) {
      throw new Error("School-survey catalog response did not include a body");
    }

    return data(
      S.decodeUnknownSync(SchoolSurveyAdminCatalogResource)(result.body, {
        onExcessProperty: "error",
      }),
      { headers: responseHeaders },
    );
  } catch (error) {
    return failure(tagFrom(error));
  }
}

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch (error) {
    return failure(tagFrom(error));
  }

  let operation: S.Schema.Type<typeof SchoolSurveysBridgeOperation>;

  try {
    operation = S.decodeUnknownSync(SchoolSurveysBridgeOperation)(
      await request.json().catch(() => null),
      { onExcessProperty: "error" },
    );
  } catch {
    return failure("SurveyDecodeError");
  }

  try {
    const surveys = createAuthenticatedClient(cookie, request).surveys;

    switch (operation.operation) {
      case "list": {
        const result = await surveys.listAdminSurveys({ query: operation.query });

        if (result.body === undefined) {
          throw new Error("School-survey list response did not include a body");
        }

        return data(
          S.decodeUnknownSync(SchoolSurveyAdminListResource)(result.body, {
            onExcessProperty: "error",
          }),
          { headers: responseHeaders },
        );
      }

      case "create": {
        const { operation: _, commandId, ...payload } = operation;

        const result = await surveys.createAdminSurvey({
          headers: { "idempotency-key": commandId },
          payload,
        });

        if (result.body === undefined) {
          throw new Error("School-survey create response did not include a body");
        }

        return data(
          S.decodeUnknownSync(SchoolSurveyAdminResource)(result.body, {
            onExcessProperty: "error",
          }),
          { headers: responseHeaders },
        );
      }

      case "close": {
        const { operation: _, commandId, surveyId, ...payload } = operation;

        const result = await surveys.closeAdminSurvey({
          params: { surveyId },
          headers: { "idempotency-key": commandId },
          payload,
        });

        if (result.body === undefined) {
          throw new Error("School-survey close response did not include a body");
        }

        return data(
          S.decodeUnknownSync(SchoolSurveyAdminResource)(result.body, {
            onExcessProperty: "error",
          }),
          { headers: responseHeaders },
        );
      }

      case "results": {
        const result = await surveys.readAdminResults({ params: { surveyId: operation.surveyId } });

        if (result.body === undefined) {
          throw new Error("School-survey results response did not include a body");
        }

        return data(
          S.decodeUnknownSync(SchoolSurveyResultsResource)(result.body, {
            onExcessProperty: "error",
          }),
          { headers: responseHeaders },
        );
      }
    }
  } catch (error) {
    return failure(tagFrom(error));
  }
}

export const headers = () => responseHeaders;
