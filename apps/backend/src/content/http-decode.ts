/** Content query strings: the department filter and the published version selector. */
import type { ContentWorkspaceQuery } from "@vektorprogrammet/domain/content";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect } from "effect";

/**
 * A workspace or news listing accepts at most one department filter and no
 * other parameter. The endpoint's query schema has already decoded it.
 *
 * @construct http-problem
 */
export const departmentQuery = (
  request: Request,
  department: DepartmentId | undefined,
): Effect.Effect<ContentWorkspaceQuery, Problem<"request.malformed">> => {
  const keys = [...new URL(request.url).searchParams.keys()];

  return keys.length > 1 || keys.some((key) => key !== "department")
    ? Effect.fail(Problem.make("request.malformed"))
    : Effect.succeed(department === undefined ? {} : { departmentId: department });
};

/**
 * A news article read accepts at most one positive published version and no other parameter.
 *
 * @construct http-problem
 */
export const versionFromQuery = (
  request: Request,
): Effect.Effect<number | undefined, Problem<"request.malformed">> => {
  const parameters = [...new URL(request.url).searchParams];

  if (parameters.length === 0) return Effect.undefined;

  const version = Number(parameters[0]?.[1]);

  return parameters.length === 1 &&
    parameters[0]?.[0] === "version" &&
    Number.isSafeInteger(version) &&
    version >= 1
    ? Effect.succeed(version)
    : Effect.fail(Problem.make("request.malformed"));
};
