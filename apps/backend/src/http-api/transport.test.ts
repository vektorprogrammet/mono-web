import { backendTestConfig } from "../../test/config.js";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  ExternalNativeApi,
  InternalNativeApi,
  NativeProblem,
  Problem,
} from "@vektorprogrammet/http-api";
import { Effect, Layer, Schema, SchemaAST, SchemaIssue } from "effect";
import {
  HttpApi,
  HttpApiError,
  type HttpApiEndpoint,
  type HttpApiGroup,
} from "effect/unstable/httpapi";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  makeContentManagementTestHttp,
  makeOrganizationTestHttp,
  makeProfileTestHttp,
} from "../test/native-http.js";
import { requestSchemaErrorResponse } from "./transport.js";

const expectProblem = (response: Response, status: number, code: string) =>
  Effect.gen(function* () {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = yield* Effect.promise(() => response.json());
    expect(body).toMatchObject({
      type: `urn:vektorprogrammet:problem:v0.2:${code}`,
      status,
      code,
    });
    expect(body).not.toHaveProperty("error");
  });

const unreachable = vi.fn(() => Effect.die("request schema failure reached endpoint dispatch"));

const securityServices = Layer.mergeAll(
  Layer.mock(Identity, {
    signIn: () => Effect.die("Unexpected sign-in"),
    readCurrentSession: () => Effect.die("Unexpected session read"),
    listSessions: () => Effect.die("Unexpected session list"),
    revokeCurrentSession: () => Effect.die("Unexpected session mutation"),
    revokeSession: () => Effect.die("Unexpected session mutation"),
    revokeOtherSessions: () => Effect.die("Unexpected session mutation"),
    revokeAllSessions: () => Effect.die("Unexpected session mutation"),
    recordSecurityEvent: () => Effect.die("Unexpected identity audit"),
    signOut: () => Effect.die("Unexpected sign-out"),
    resolveSession: () =>
      Effect.fail(
        new IdentityEngineError({
          operation: "resolveSession",
          message: "request schema failure reached authentication",
        }),
      ),
  }),
  Layer.mock(OAuthCredentialAuthority, {
    resolve: () => Effect.die("request schema failure reached authentication"),
  }),
);

const validIdempotencyKey = "A".repeat(22);

const validETag = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

describe("native request schema error transport", () => {
  it.live.each([
    ["missing If-Match", { "idempotency-key": validIdempotencyKey }, 428, "precondition.required"],
    [
      "malformed If-Match",
      { "idempotency-key": validIdempotencyKey, "if-match": `W/${validETag}` },
      400,
      "precondition.invalid",
    ],
    [
      "malformed Idempotency-Key",
      { "idempotency-key": "too-short", "if-match": validETag },
      400,
      "idempotency-key.invalid",
    ],
  ] as const)("maps %s before dispatch", ([_name, transportHeaders, status, code]) =>
    Effect.gen(function* () {
      unreachable.mockClear();

      const response = yield* makeProfileTestHttp(
        {
          config: backendTestConfig,
          resolveActor: unreachable,
        },
        securityServices,
      ).fetch(
        new Request("http://backend.test/api/profile", {
          method: "PATCH",
          headers: {
            cookie: "better-auth.session_token=transport-test-session",
            "content-type": "application/merge-patch+json",
            origin: "http://127.0.0.1:5174",
            ...transportHeaders,
          },
          body: '{"firstName":"Ada"}',
        }),
      );

      yield* expectProblem(response, status, code);
      expect(unreachable).not.toHaveBeenCalled();
    }),
  );

  it.live("maps query decoding to request.malformed before dispatch", () =>
    Effect.gen(function* () {
      unreachable.mockClear();

      const response = yield* makeOrganizationTestHttp(
        {
          config: backendTestConfig.organization,
          resolveActor: unreachable,
          resolveAuthority: unreachable,
        },
        securityServices,
      ).fetch(
        new Request("http://backend.test/api/mailing-lists?type=unknown", {
          headers: { cookie: "better-auth.session_token=transport-test-session" },
        }),
      );

      yield* expectProblem(response, 400, "request.malformed");
      expect(unreachable).not.toHaveBeenCalled();
    }),
  );

  it.live("maps path-parameter decoding to request.malformed before dispatch", () =>
    Effect.gen(function* () {
      unreachable.mockClear();

      const response = yield* makeContentManagementTestHttp(unreachable, securityServices).fetch(
        new Request("http://backend.test/api/content/articles/not-a-number", {
          headers: { cookie: "better-auth.session_token=transport-test-session" },
        }),
      );

      yield* expectProblem(response, 400, "request.malformed");
      expect(unreachable).not.toHaveBeenCalled();
    }),
  );
});

const inputProperties = (schema: Schema.Top | undefined) => {
  const ast = schema === undefined ? undefined : SchemaAST.toType(schema.ast);

  return ast !== undefined && SchemaAST.isObjects(ast) ? ast.propertySignatures : [];
};

/** Every request-schema failure HttpApiBuilder can raise before dispatching one endpoint. */
const requestSchemaErrors = (endpoint: HttpApiEndpoint.Top) => {
  const errors: Array<HttpApiError.HttpApiSchemaError> = [];

  const raise = (kind: HttpApiError.HttpApiSchemaError["kind"], issue: SchemaIssue.Issue) =>
    errors.push(
      new HttpApiError.HttpApiSchemaError({ kind, cause: new Schema.SchemaError(issue) }),
    );

  for (const header of inputProperties(endpoint.headers)) {
    raise(
      "Headers",
      new SchemaIssue.Pointer([header.name], new SchemaIssue.InvalidType(header.type)),
    );

    if (!SchemaAST.isOptional(header.type)) {
      raise(
        "Headers",
        new SchemaIssue.Pointer([header.name], new SchemaIssue.MissingKey(undefined)),
      );
    }
  }

  for (const [kind, schema] of [
    ["Params", endpoint.params],
    ["Query", endpoint.query],
  ] as const) {
    for (const property of inputProperties(schema)) {
      raise(
        kind,
        new SchemaIssue.Pointer([property.name], new SchemaIssue.InvalidType(property.type)),
      );
    }
  }

  return errors;
};

interface SchemaErrorCheck {
  readonly operation: string;
  readonly declared: ReadonlyArray<Schema.Top>;
  readonly error: HttpApiError.HttpApiSchemaError;
}

const schemaErrorChecks = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) => {
  const checks: Array<SchemaErrorCheck> = [];

  HttpApi.reflect(api, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint, errors }) => {
      for (const error of requestSchemaErrors(endpoint)) {
        checks.push({
          operation: `${group.identifier}.${endpoint.identifier}`,
          declared: [...errors.values()].flat(),
          error,
        });
      }
    },
  });

  return checks;
};

describe("request schema error coverage", () => {
  it.live("answers every request schema failure with a problem the endpoint declares", () =>
    Effect.gen(function* () {
      const checks = [
        ...schemaErrorChecks(ExternalNativeApi),
        ...schemaErrorChecks(InternalNativeApi),
      ];

      const answered = new Set<string>();
      const gaps: Array<string> = [];

      for (const { operation, declared, error } of checks) {
        const { code } = Schema.decodeUnknownSync(NativeProblem)(
          yield* Effect.promise(() => requestSchemaErrorResponse(error).json()),
        );

        const problem = Problem.fromWire({ code }, {});
        answered.add(code);

        if (!declared.some((schema) => Schema.is(schema)(problem))) {
          gaps.push(`${operation} ${error.kind} ${code}`);
        }
      }

      // Every client-caused transform branch is reachable from some declared endpoint input.
      expect([...answered].sort()).toEqual([
        "header.malformed",
        "idempotency-key.invalid",
        "precondition.invalid",
        "precondition.required",
        "request.malformed",
      ]);
      expect(gaps).toEqual([]);
    }),
  );
});
