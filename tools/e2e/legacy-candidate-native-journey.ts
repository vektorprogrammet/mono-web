import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import { AuthEngine, AuthLive, OAUTH_NATIVE_API_RESOURCE } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { ReturningAssistantsLive } from "@vektorprogrammet/database/application";
import { ContentLive, ContentManagementLive } from "@vektorprogrammet/database/content";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import { EconomyLive } from "@vektorprogrammet/database/receipt/postgres";
import { RecruitmentLive } from "@vektorprogrammet/database/recruitment";
import { SchoolsLive } from "@vektorprogrammet/database/schools";
import { SocialEventsLive } from "@vektorprogrammet/database/social-events";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import { PlacementsLive } from "@vektorprogrammet/database/placements";
import {
  OwnAffiliationResource,
  PlacementBoardResource,
  PlacementScopes,
  nativeRpcPath,
  OwnProfileResource,
  ReceiptFileContent,
  ReceiptListResponse,
} from "@vektorprogrammet/rpc";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { Etag, FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { ReceiptDeliveryLive } from "@vektorprogrammet/backend/receipt/delivery";
import {
  backendHttpHandler,
  decodeBackendConfig,
  ExternalNativeRpcRouterLive,
  nativeRouterWebHandler,
} from "@vektorprogrammet/backend";
import {
  nativeRpcRequestBody,
  nativeRpcStatus,
  nativeRpcValue,
} from "../../apps/dashboard/e2e/native-operations.js";
import type { RehearsalTarget } from "./legacy-organization-rehearsal-runtime.js";

export interface CandidateNativeIdentity {
  readonly personId: string;
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface LegacyCandidateNativeJourneyInput {
  readonly target: RehearsalTarget;
  readonly asOf: string;
  readonly authSecret: string;
  readonly identities: Readonly<
    Record<"leader" | "member" | "historicalLeader" | "otherDepartment", CandidateNativeIdentity>
  >;
  readonly scope: {
    readonly departmentId: string;
    readonly semesterId: string;
    readonly otherDepartmentId: string;
  };
  readonly receipt: {
    readonly receiptId: string;
    readonly ownerPersonId: string;
    readonly sha256: string;
  };
  readonly receiptStore: {
    readonly stagingRoot: string;
    readonly committedRoot: string;
  };
  /** Caller retains this synthetic secret and supplies it on subsequent journeys. */
  readonly changeMemberPasswordTo?: string;
}

/** Real Request/Response boundary and PostgreSQL services; no listener, worker, or provider. */
export const observeLegacyCandidateNativeJourney = async (
  input: LegacyCandidateNativeJourneyInput,
) => {
  const backendOrigin = "http://127.0.0.1:4790";
  const dashboardOrigin = "http://127.0.0.1:4791";

  const config = Effect.runSync(
    decodeBackendConfig({
      BACKEND_PG_URL: input.target.url,
      BETTER_AUTH_SECRET: input.authSecret,
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE,
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      RECEIPT_STAGING_ROOT: input.receiptStore.stagingRoot,
      RECEIPT_COMMITTED_ROOT: input.receiptStore.committedRoot,
    }),
  );

  // Same live service graph as apps/backend/src/main.ts, without delivery workers.
  const database = DatabaseLive({
    url: Redacted.make(input.target.url),
    applicationName: "candidate-native-journey",
    maxConnections: 4,
  }).pipe(Layer.provide(BunServices.layer));

  const platform = Layer.merge(BunServices.layer, FetchHttpClient.layer);
  const admissions = AdmissionsLive.pipe(Layer.provide(database));
  const organization = OrganizationLive.pipe(Layer.provide(database));
  const profile = ProfileLive.pipe(Layer.provide(Layer.merge(database, organization)));

  const services = Layer.mergeAll(
    database,
    admissions,
    organization,
    profile,
    EconomyLive.pipe(Layer.provide(database)),
    PlacementsLive.pipe(Layer.provide(database)),
    ReturningAssistantsLive.pipe(Layer.provide(database)),
    SchoolsLive.pipe(Layer.provide(database)),
    ContentManagementLive.pipe(Layer.provide(database)),
    ContentLive.pipe(Layer.provide(Layer.mergeAll(database, organization, profile))),
    RecruitmentLive.pipe(
      Layer.provide(Layer.mergeAll(database, admissions, organization, profile)),
    ),
    SocialEventsLive.pipe(Layer.provide(database)),
    TeamApplicationsLive().pipe(Layer.provide(database)),
    ReceiptDeliveryLive(undefined).pipe(Layer.provide(Layer.merge(database, platform))),
    AuthLive(config.auth).pipe(Layer.provide(database)),
  );

  const http = Layer.mergeAll(platform, BunHttpPlatform.layer, Etag.layer, HttpRouter.layer);

  const nativeApi = ExternalNativeRpcRouterLive({ config, now: () => input.asOf }).pipe(
    HttpRouter.provideRequest(Layer.merge(services, platform)),
    Layer.provide(services),
    Layer.provide(http),
  );

  const runtime = ManagedRuntime.make(Layer.mergeAll(services, http, nativeApi));
  const checks: string[] = [];
  let phase = "runtime-start";

  try {
    const router = await runtime.runPromise(HttpRouter.HttpRouter);

    const engine = await runtime.runPromise(AuthEngine);

    // This journey signs in through the identity handler; it exercises no OAuth surface.
    const api = backendHttpHandler(
      nativeRouterWebHandler(router),
      {
        handler: engine.handler,
        recordTrustedOriginRejection: engine.recordTrustedOriginRejection,
      },
      config.sessionBoundary,
    );

    const request = (path: string, cookie?: string, body?: Schema.Json, authorization?: string) => {
      const headers = new Headers({ origin: dashboardOrigin });

      if (cookie !== undefined) headers.set("cookie", cookie);

      if (body !== undefined) headers.set("content-type", "application/json");

      if (authorization !== undefined) headers.set("authorization", authorization);

      const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers };

      if (body !== undefined) init.body = JSON.stringify(body);

      return runtime.runPromise(api(new Request(backendOrigin + path, init)));
    };

    const status = async (name: string, path: string, expected: number, cookie?: string) => {
      phase = name;
      const response = await request(path, cookie);
      assert.equal(response.status, expected);
      await response.body?.cancel();
      checks.push(name);
    };

    const json = async <S extends Schema.ConstraintDecoder<unknown, never>>(
      name: string,
      path: string,
      schema: S,
      cookie: string,
    ) => {
      phase = name;
      const response = await request(path, cookie);
      assert.equal(response.status, 200);
      const result = Schema.decodeUnknownSync(schema)(await response.json());

      return result;
    };

    /** Reads the caller's own profile over RPC and answers its status under the HTTP contract. */
    const readOwnProfile = async (name: string, cookie?: string) => {
      phase = name;
      const headers = new Headers({ origin: dashboardOrigin, "content-type": "application/json" });

      if (cookie !== undefined) headers.set("cookie", cookie);

      const response = await runtime.runPromise(
        api(
          new Request(backendOrigin + nativeRpcPath, {
            method: "POST",
            headers,
            body: nativeRpcRequestBody("profile.readOwnProfile"),
          }),
        ),
      );

      const answer = await response.text();

      return { status: nativeRpcStatus(answer), value: nativeRpcValue(answer) };
    };

    /**
     * One receipt RPC as a browser posts it, with its credential and origin as HTTP headers,
     * answered with its status under the HTTP contract and its value.
     */
    const receiptRpc = (
      name: string,
      tag: "receipts.listReceipts" | "receipts.readReceiptFile",
      payload: Schema.Json,
      cookie?: string,
      authorization?: string,
    ) => {
      phase = name;
      const headers = new Headers({ origin: dashboardOrigin, "content-type": "application/json" });

      if (cookie !== undefined) headers.set("cookie", cookie);

      if (authorization !== undefined) headers.set("authorization", authorization);

      const request = new Request(backendOrigin + nativeRpcPath, {
        method: "POST",
        headers,
        body: nativeRpcRequestBody(tag, payload),
      });

      return runtime
        .runPromise(api(request))
        .then((response) => response.text())
        .then((answer) => ({ status: nativeRpcStatus(answer), value: nativeRpcValue(answer) }));
    };

    const ownProfile = async (name: string, cookie: string) => {
      const answer = await readOwnProfile(name, cookie);
      assert.equal(answer.status, 200);

      return Schema.decodeUnknownSync(OwnProfileResource)(answer.value).profile;
    };

    const ownProfileStatus = async (name: string, expected: number, cookie?: string) => {
      assert.equal((await readOwnProfile(name, cookie)).status, expected);
      checks.push(name);
    };

    /** Calls one RPC as a browser would, and answers its status under the HTTP contract. */
    const callRpc = (name: string, tag: string, payload: Schema.Json, cookie?: string) => {
      phase = name;
      const headers = new Headers({ origin: dashboardOrigin, "content-type": "application/json" });

      if (cookie !== undefined) headers.set("cookie", cookie);

      return runtime
        .runPromise(
          api(
            new Request(backendOrigin + nativeRpcPath, {
              method: "POST",
              headers,
              body: nativeRpcRequestBody(tag, payload),
            }),
          ),
        )
        .then((response) => response.text())
        .then((answer) => ({ status: nativeRpcStatus(answer), value: nativeRpcValue(answer) }));
    };

    const rpcJson = <S extends Schema.ConstraintDecoder<unknown, never>>(
      name: string,
      tag: string,
      payload: Schema.Json,
      schema: S,
      cookie: string,
    ) =>
      callRpc(name, tag, payload, cookie).then((answer) => {
        assert.equal(answer.status, 200);

        return Schema.decodeSync(schema)(answer.value);
      });

    const rpcStatus = (
      name: string,
      tag: string,
      payload: Schema.Json,
      expected: number,
      cookie?: string,
    ) =>
      callRpc(name, tag, payload, cookie).then((answer) => {
        assert.equal(answer.status, expected);
        checks.push(name);
      });

    const signIn = async (label: string, identity: CandidateNativeIdentity) => {
      phase = `${label}-native-sign-in`;

      const response = await request("/api/auth/sign-in/email", undefined, {
        email: identity.email,
        password: identity.password,
      });

      if (response.status !== 200) phase = `${phase}-status-${response.status}`;
      assert.equal(response.status, 200);

      const body = Schema.decodeUnknownSync(
        Schema.Struct({ user: Schema.Struct({ id: Schema.String }) }),
      )(await response.json());

      assert.equal(body.user.id, identity.personId);

      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");

      assert.ok(cookie.includes("better-auth.session_token="));
      checks.push(phase);

      return cookie;
    };

    const cookies = {
      leader: await signIn("leader", input.identities.leader),
      member: await signIn("member", input.identities.member),
      historicalLeader: await signIn("historicalLeader", input.identities.historicalLeader),
      otherDepartment: await signIn("otherDepartment", input.identities.otherDepartment),
    };

    for (const label of ["leader", "member", "otherDepartment"] as const) {
      const result = await ownProfile(`${label}-own-profile`, cookies[label]);

      const identity = input.identities[label];
      assert.equal(result.personId, identity.personId);
      assert.equal(result.firstName, identity.firstName);
      assert.equal(result.lastName, identity.lastName);
      assert.equal(result.email, identity.email);
      assert.equal(result.role, label === "member" ? "ROLE_TEAM_MEMBER" : "ROLE_TEAM_LEADER");
      checks.push(phase);
    }

    await ownProfileStatus("historical-profile-authority-denied", 403, cookies.historicalLeader);
    await ownProfileStatus("anonymous-profile-denied", 401);

    for (const label of ["leader", "member", "historicalLeader", "otherDepartment"] as const) {
      const scopes = await rpcJson(
        `${label}-native-scope`,
        "placements.listScopes",
        null,
        PlacementScopes,
        cookies[label],
      );

      assert.equal(
        scopes.departments.find((entry) => entry.departmentId === input.scope.departmentId)
          ?.canManage,
        label === "leader",
      );
      assert.equal(
        scopes.departments.find((entry) => entry.departmentId === input.scope.otherDepartmentId)
          ?.canManage,
        label === "otherDepartment",
      );
      checks.push(phase);
    }

    const organizationPath = (department: string) =>
      `/api/mailing-lists?${new URLSearchParams({ type: "assistants", department, semester: input.scope.semesterId }).toString()}`;

    await status(
      "leader-organization-own-scope",
      organizationPath(input.scope.departmentId),
      200,
      cookies.leader,
    );
    await status(
      "leader-organization-other-scope-denied",
      organizationPath(input.scope.otherDepartmentId),
      403,
      cookies.leader,
    );

    for (const label of ["member", "historicalLeader", "otherDepartment"] as const) {
      await status(
        `${label}-organization-scope-denied`,
        organizationPath(input.scope.departmentId),
        403,
        cookies[label],
      );
    }

    const affiliationScope = { departmentId: input.scope.departmentId };

    const ownAffiliation = await rpcJson(
      "member-imported-affiliation",
      "placements.readOwnAffiliation",
      affiliationScope,
      OwnAffiliationResource,
      cookies.member,
    );

    assert.equal(ownAffiliation.personId, input.identities.member.personId);
    assert.equal(ownAffiliation.status, "Active");
    checks.push(phase);

    const foreignAffiliation = await rpcJson(
      "other-affiliation-isolation",
      "placements.readOwnAffiliation",
      affiliationScope,
      OwnAffiliationResource,
      cookies.otherDepartment,
    );

    assert.equal(foreignAffiliation.personId, input.identities.otherDepartment.personId);
    assert.equal(foreignAffiliation.status, "Absent");
    checks.push(phase);

    // The RPC payload has no person selector: a forged one is dropped, and the caller still reads
    // only their own affiliation.
    const overridden = await rpcJson(
      "affiliation-person-override-ignored",
      "placements.readOwnAffiliation",
      { ...affiliationScope, personId: input.identities.member.personId },
      OwnAffiliationResource,
      cookies.otherDepartment,
    );

    assert.equal(overridden.personId, input.identities.otherDepartment.personId);
    checks.push(phase);

    const boardScope = (departmentId: string) => ({
      departmentId,
      semesterId: input.scope.semesterId,
    });

    const board = await rpcJson(
      "leader-imported-placement",
      "placements.readBoard",
      boardScope(input.scope.departmentId),
      PlacementBoardResource,
      cookies.leader,
    );

    assert.equal(board.departmentId, input.scope.departmentId);
    assert.equal(board.semesterId, input.scope.semesterId);
    assert.ok(
      board.placements.some(
        (placement) => placement.personId === input.identities.member.personId && placement.active,
      ),
    );
    checks.push(phase);
    await rpcStatus(
      "leader-other-placement-scope-denied",
      "placements.readBoard",
      boardScope(input.scope.otherDepartmentId),
      403,
      cookies.leader,
    );

    for (const label of ["member", "historicalLeader", "otherDepartment"] as const) {
      await rpcStatus(
        `${label}-placement-board-denied`,
        "placements.readBoard",
        boardScope(input.scope.departmentId),
        403,
        cookies[label],
      );
    }

    await rpcStatus(
      "anonymous-placement-denied",
      "placements.readBoard",
      boardScope(input.scope.departmentId),
      401,
    );

    assert.equal(input.receipt.ownerPersonId, input.identities.member.personId);

    for (const label of ["leader", "member", "historicalLeader", "otherDepartment"] as const) {
      const listed = await receiptRpc(
        `${label}-receipt-owner-isolation`,
        "receipts.listReceipts",
        {},
        cookies[label],
      );

      assert.equal(listed.status, 200);
      const receipts = Schema.decodeUnknownSync(ReceiptListResponse)(listed.value);

      assert.ok(
        receipts.items.every((item) => item.ownerPersonId === input.identities[label].personId),
      );
      assert.equal(
        receipts.items.some((item) => item.receiptId === input.receipt.receiptId),
        label === "member",
      );
      checks.push(phase);
    }

    const fileRead = { receiptId: input.receipt.receiptId };

    const downloaded = await receiptRpc(
      "owner-private-receipt-bytes",
      "receipts.readReceiptFile",
      fileRead,
      cookies.member,
    );

    assert.equal(downloaded.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(Schema.decodeUnknownSync(ReceiptFileContent)(downloaded.value).bytes))
        .digest("hex"),
      input.receipt.sha256,
    );
    checks.push(phase);

    for (const label of ["leader", "historicalLeader", "otherDepartment"] as const) {
      const denied = await receiptRpc(
        `${label}-private-receipt-denied`,
        "receipts.readReceiptFile",
        fileRead,
        cookies[label],
      );

      assert.equal(denied.status, 404);
      checks.push(phase);
    }

    const anonymous = await receiptRpc(
      "anonymous-private-receipt-denied",
      "receipts.readReceiptFile",
      fileRead,
    );

    assert.equal(anonymous.status, 401);
    checks.push(phase);

    const invalidBearer = await receiptRpc(
      "invalid-bearer-no-cookie-fallback",
      "receipts.readReceiptFile",
      fileRead,
      cookies.member,
      "Bearer candidate-invalid",
    );

    assert.equal(invalidBearer.status, 401);
    checks.push(phase);

    if (input.changeMemberPasswordTo !== undefined) {
      phase = "member-native-password-change";

      const changed = await request("/api/auth/change-password", cookies.member, {
        currentPassword: input.identities.member.password,
        newPassword: input.changeMemberPasswordTo,
        revokeOtherSessions: true,
      });

      assert.equal(changed.status, 200);
      await changed.body?.cancel();
      checks.push(phase);
      cookies.member = await signIn("member-changed-password", {
        ...input.identities.member,
        password: input.changeMemberPasswordTo,
      });

      const afterChange = await ownProfile("changed-password-same-person", cookies.member);

      assert.equal(afterChange.personId, input.identities.member.personId);
      checks.push(phase);
    }

    return {
      boundary: "NativeRequestResponseWithRealBetterAuthAndPostgreSQL" as const,
      authorizationInstant: input.asOf,
      checks,
    };
  } catch {
    // Native exceptions and assertions can carry personal fields or credential material.
    throw new Error(`Candidate native journey failed: ${phase}`);
  } finally {
    await runtime.dispose();
  }
};
