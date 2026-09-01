import {
  ConfigurationError,
  NetworkError,
  DepartmentId,
  SchoolDirectorySchema,
  SchoolsRejectionError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { Schema as S } from "effect";
import { data } from "react-router";
import { schoolsBridgeFailure, type SchoolsBridgeErrorTag } from "../foldkit/schools/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.schools";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const statusFor = (tag: SchoolsBridgeErrorTag): number => {
  switch (tag) {
    case "UnauthenticatedActor":
      return 401;
    case "AuthorityInactive":
    case "NotInScope":
    case "SchoolsDepartmentOutOfScope":
      return 403;
    case "SchoolsDepartmentNotFound":
      return 422;
    case "Network":
      return 502;
    case "SchoolsPersistenceError":
    case "SchoolsDecodeError":
    case "Configuration":
      return 503;
  }
};

const tagFrom = (error: unknown): SchoolsBridgeErrorTag => {
  if (error instanceof SchoolsRejectionError) return error.schoolsTag;
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return "UnauthenticatedActor";
  }
  if (error instanceof UnauthorizedError) return "UnauthenticatedActor";
  if (error instanceof ConfigurationError) return "Configuration";
  if (error instanceof NetworkError) {
    return error.cause === undefined ? "SchoolsPersistenceError" : "Network";
  }
  return "SchoolsPersistenceError";
};

const decodeDepartment = (request: Request): typeof DepartmentId.Type | undefined => {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => key !== "department")) {
    throw new Error("unexpected Schools bridge query parameter");
  }
  const values = search.getAll("department");
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("duplicate Schools bridge department");
  return S.decodeUnknownSync(DepartmentId)(values[0]);
};

export async function loader({ request }: Route.LoaderArgs) {
  let cookie: string;
  try {
    cookie = await requireAuth(request);
  } catch (error) {
    const tag = tagFrom(error);
    return data(schoolsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }

  let department: typeof DepartmentId.Type | undefined;
  try {
    department = decodeDepartment(request);
  } catch {
    return data(schoolsBridgeFailure("SchoolsDecodeError"), {
      status: 422,
      headers: responseHeaders,
    });
  }

  try {
    const client = createAuthenticatedClient(cookie, request);
    const directory = await client.admin.schools.list(
      department === undefined ? undefined : { department },
    );
    return data(
      S.decodeUnknownSync(SchoolDirectorySchema)(directory, { onExcessProperty: "error" }),
      { headers: responseHeaders },
    );
  } catch (error) {
    const tag = tagFrom(error);
    return data(schoolsBridgeFailure(tag), {
      status: statusFor(tag),
      headers: responseHeaders,
    });
  }
}
