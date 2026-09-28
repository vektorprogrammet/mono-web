import { expect, it } from "@effect/vitest";
import { Identity, IdentitySessionNotFound } from "@vektorprogrammet/domain/identity";
import { isProblem } from "@vektorprogrammet/rpc/problem";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SemesterId } from "@vektorprogrammet/domain";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";

// The identity engine rejects every session, as it does a forged or expired one.
const rejectingIdentity = Layer.mock(Identity, {
  resolveSession: () => Effect.fail(new IdentitySessionNotFound({})),
});

const backend = makeBackendTestRpc(backendTestConfig, rejectingIdentity);

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
