import { expect, it } from "@effect/vitest";
import { Identity, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { isProblem } from "@vektorprogrammet/rpc/problem";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SemesterId } from "@vektorprogrammet/domain";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendTestConfig } from "../../test/config.js";
import { backendHttpHandler } from "../router.js";
import { makeBackendTestRpc, testAuthHandler } from "../test/native-rpc.js";

// The identity engine rejects every session, as it does a forged or expired one.
const rejectingIdentity = Layer.mock(Identity, {
  resolveSession: () => Effect.fail(IdentitySessionNotFound.make({})),
});

const backend = makeBackendTestRpc({ config: backendTestConfig, services: rejectingIdentity });

it.effect("an RPC without a credential answers credential.missing from the middleware", () =>
  Effect.gen(function* () {
    const client = yield* backend.client;

    const failure = yield* Effect.flip(client["social-events.readScope"]());

    expect(isProblem(failure) && failure.code).toBe("credential.missing");
  }),
);

it.effect("a malformed Better Auth cookie answers credential.invalid", () =>
  Effect.gen(function* () {
    const client = yield* backend.client;

    const failure = yield* Effect.flip(
      RpcClient.withHeaders(
        client["social-events.list"]({
          departmentId: DepartmentId.make("department-a"),
          semesterId: SemesterId.make("semester-a"),
        }),
        { cookie: "better-auth.session_token=forged" },
      ),
    );

    expect(isProblem(failure) && failure.code).toBe("credential.invalid");
  }),
);

it.effect("the health probe stays plain HTTP", () =>
  Effect.gen(function* () {
    const response = yield* backend.fetch(new Request("http://native-rpc.test/health"));

    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ status: "ok" });
  }),
);

it.effect("a path outside the RPC endpoint and the probe answers resource.not-found", () =>
  Effect.gen(function* () {
    const response = yield* backend.fetch(new Request("http://native-rpc.test/api/social-events"));

    expect(response.status).toBe(404);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      code: "resource.not-found",
    });
  }),
);

it.effect("an RPC from an untrusted origin answers origin.denied before any handler", () =>
  Effect.gen(function* () {
    const response = yield* backend.fetch(
      new Request("http://native-rpc.test/api/rpc", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          cookie: "better-auth.session_token=x",
          "content-type": "application/json",
        },
        body: "[]",
      }),
    );

    expect(response.status).toBe(403);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: "origin.denied" });
  }),
);

it.effect("the ingress drops message headers that would forge an ingress fact", () =>
  Effect.gen(function* () {
    const received: Array<string> = [];

    const recordingNative = (request: Request) =>
      Effect.promise(() => request.text()).pipe(
        Effect.map((body) => {
          received.push(body);

          return new Response("[]", { headers: { "content-type": "application/json" } });
        }),
      );

    const ingress = backendHttpHandler(
      recordingNative,
      testAuthHandler,
      backendTestConfig.sessionBoundary,
    );

    // RPC wire text: one request message with forged ingress headers, and one ack.
    const sent =
      '[{"_tag":"Request","id":"1","tag":"social-events.readScope","payload":null,"headers":' +
      '[["cookie","better-auth.session_token=forwarded"],["cf-connecting-ip","203.0.113.9"],' +
      '["User-Agent","forged"],["x-vektor-request-id","forged"]]},{"_tag":"Ack","requestId":"1"}]';

    const expected =
      '[{"_tag":"Request","id":"1","tag":"social-events.readScope","payload":null,"headers":' +
      '[["cookie","better-auth.session_token=forwarded"]]},{"_tag":"Ack","requestId":"1"}]';

    yield* ingress(
      new Request("http://native-rpc.test/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent,
      }),
    );

    const wire = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

    expect(yield* Effect.forEach(received, (body) => wire(body))).toEqual([yield* wire(expected)]);
  }),
);
