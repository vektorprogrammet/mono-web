import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Problem, ReadSession, SessionResponse } from "@vektorprogrammet/rpc";
import { Exit, Predicate } from "effect";
import { Rpc } from "effect/unstable/rpc";
import {
  isNativeOperation,
  isNativeRequest,
  nativeRpcOutcome,
  nativeRpcStatus,
  nativeRpcTag,
} from "../e2e/native-operations.ts";
import { addressesRoute } from "../e2e/request-routes.ts";

/** The RPC request message that the client posts for one RPC. */
const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Finite,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const Ack = Schema.TaggedStruct("Ack", { requestId: Schema.Finite });

const RpcExitMessage = Schema.TaggedStruct("Exit", { requestId: Schema.Finite, exit: Schema.Json });

const encodeReadSessionExit = Schema.encodeSync(Schema.toCodecJson(Rpc.exitSchema(ReadSession)));

/** The response body that the RPC server writes for one `system.readSession` exit. */
const readSessionAnswer = (exit: Rpc.Exit<typeof ReadSession>) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Array(RpcExitMessage)))([
    RpcExitMessage.make({ requestId: 0, exit: encodeReadSessionExit(exit) }),
  ]);

const session = SessionResponse.make({
  sessionId: "session-1",
  personId: PersonId.make("person-1"),
  createdAt: "2030-01-01T00:00:00Z",
  updatedAt: "2030-01-01T00:00:00Z",
  expiresAt: "2030-01-02T00:00:00Z",
  ipAddress: null,
  userAgent: null,
  current: true,
});

const rpcBody = (tag: string, payload: Schema.Json = {}) =>
  Schema.encodeSync(Schema.fromJsonString(RpcRequest))(
    RpcRequest.make({ id: 0, tag, payload, headers: [] }),
  );

describe("journey request route classification", () => {
  it("keeps an RPC of the contract native, whatever its payload holds", () => {
    const sessionId = "wm97nHEWTDO8UArCXrVpni919bgIjwTB";
    const body = rpcBody("system.deleteOwnedSession", { idempotencyKey: "k", sessionId });

    expect(isNativeRequest("POST", "/api/rpc", body)).toBe(true);
    expect(isNativeRequest("POST", "/api/rpc/", body)).toBe(true);
    expect(isNativeRequest("POST", "/api/rpc")).toBe(true);
    expect(isNativeRequest("GET", "/health")).toBe(true);
  });

  it("matches the method, the whole endpoint path, and a tag of the contract", () => {
    expect(isNativeOperation("POST", "/api/rpc", rpcBody("profile.readOwnProfile"))).toBe(true);
    expect(isNativeOperation("GET", "/api/rpc", rpcBody("profile.readOwnProfile"))).toBe(false);
    expect(isNativeOperation("POST", "/api/rpcs", rpcBody("profile.readOwnProfile"))).toBe(false);
    expect(isNativeOperation("POST", "/api/rpc/extra", rpcBody("profile.readOwnProfile"))).toBe(
      false,
    );
    expect(isNativeOperation("POST", "/api/rpc", rpcBody("legacy.login"))).toBe(false);
    expect(isNativeOperation("POST", "/api/rpc", "not json")).toBe(false);
    expect(isNativeOperation("POST", "/api/session")).toBe(false);
  });

  it("reads the RPC tag from the request body", () => {
    expect(nativeRpcTag(rpcBody("system.readSession"))).toBe("system.readSession");
    const ack = Schema.encodeSync(Schema.fromJsonString(Ack))(Ack.make({ requestId: 0 }));

    expect(nativeRpcTag(ack)).toBeUndefined();
  });

  it("reads the outcome and the status of an RPC response", () => {
    const success = readSessionAnswer(Exit.succeed(session));
    const denied = readSessionAnswer(Exit.fail(Problem.fromWire({ code: "credential.invalid" }, {})));

    const read = nativeRpcOutcome(success);
    const rejected = nativeRpcOutcome(denied);

    expect(Predicate.isTagged(read, "Success") && read.value).toMatchObject({ sessionId: "session-1" });
    expect(nativeRpcStatus(success)).toBe(200);
    expect(Predicate.isTagged(rejected, "Problem") && rejected.problem.code).toBe("credential.invalid");
    expect(nativeRpcStatus(denied)).toBe(401);
    expect(nativeRpcStatus(readSessionAnswer(Exit.die("boom")))).toBe(500);
    expect(nativeRpcStatus("[]")).toBeUndefined();
  });

  it("keeps the email sign-in and leaves the native surface for every other identity route", () => {
    expect(isNativeRequest("POST", "/api/auth/sign-in/email")).toBe(true);

    for (const [method, pathname] of [
      ["POST", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/callback/google"],
      ["POST", "/api/auth/request-password-reset"],
      ["POST", "/api/auth/oauth2/token"],
      ["POST", "/api/login"],
    ] as const) {
      expect(isNativeRequest(method, pathname)).toBe(false);
    }
  });

  it("addresses a route by whole consecutive segments at any depth", () => {
    expect(addressesRoute("/app/mock/api/data-brukere.ts", "/mock/api")).toBe(true);
    expect(addressesRoute("/mock/apis", "/mock/api")).toBe(false);
    expect(addressesRoute("/api/mock", "/mock/api")).toBe(false);
  });

  it("never reads an opaque segment as a route", () => {
    expect(addressesRoute("/interview-response/Xsymfony9Qa", "/symfony")).toBe(false);
    expect(addressesRoute("/assets/glemt-passord-C-r9YSzX.js", "/glemt-passord")).toBe(false);
  });

  it("addresses the route of a React Router single-fetch request", () => {
    expect(addressesRoute("/glemt-passord.data", "/glemt-passord")).toBe(true);
  });
});
