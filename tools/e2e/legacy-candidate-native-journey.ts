import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as BunHttpPlatform from "@effect/platform-bun/BunHttpPlatform";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  AuthEngine,
  AuthLive,
  OAUTH_NATIVE_API_RESOURCE,
  type AuthEngineService,
} from "@vektorprogrammet/database";
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
import { SchoolSurveysLive } from "@vektorprogrammet/database/surveys";
import { PlacementsLive } from "@vektorprogrammet/placements/server";
import { SubstitutesLive } from "@vektorprogrammet/database/substitutes";
import {
  OwnAffiliationResource,
  PlacementBoardResource,
  PlacementScopes,
  ReceiptListResponse,
  UserProfileResponse,
} from "@vektorprogrammet/http-api";
import { Cause, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { Etag, HttpEffect, HttpRouter } from "effect/unstable/http";
import { decodeBackendConfig } from "../../apps/backend/src/config.js";
import { ReceiptDeliveryLive } from "../../apps/backend/src/receipt/delivery.js";
import {
  backendHttpHandler,
  ExternalNativeApiRouterLive,
  nativeHttpRouterConfig,
  type BackendAuthHandler,
} from "../../apps/backend/src/router.js";
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

  const config = decodeBackendConfig({
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
  });

  // Same live service graph as apps/backend/src/main.ts, without delivery workers.
  const database = DatabaseLive({
    url: Redacted.make(input.target.url),
    applicationName: "candidate-native-journey",
    maxConnections: 4,
  });

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
    SubstitutesLive.pipe(Layer.provide(database)),
    ReturningAssistantsLive.pipe(Layer.provide(database)),
    SchoolsLive.pipe(Layer.provide(database)),
    ContentManagementLive.pipe(Layer.provide(database)),
    ContentLive.pipe(Layer.provide(Layer.mergeAll(database, organization, profile))),
    RecruitmentLive.pipe(
      Layer.provide(Layer.mergeAll(database, admissions, organization, profile)),
    ),
    SocialEventsLive.pipe(Layer.provide(database)),
    SchoolSurveysLive.pipe(Layer.provide(database)),
    ReceiptDeliveryLive(undefined).pipe(Layer.provide(database)),
    AuthLive(config.auth).pipe(Layer.provide(database)),
  );

  const http = Layer.mergeAll(
    BunServices.layer,
    BunHttpPlatform.layer,
    Etag.layer,
    HttpRouter.layer.pipe(
      Layer.provide(Layer.succeed(HttpRouter.RouterConfig)(nativeHttpRouterConfig)),
    ),
  );

  const nativeApi = ExternalNativeApiRouterLive(config, { now: () => input.asOf }).pipe(
    HttpRouter.provideRequest(services),
    Layer.provide(services),
    Layer.provide(http),
  );

  const runtime = ManagedRuntime.make(Layer.mergeAll(services, http, nativeApi));
  const checks: string[] = [];
  let phase = "runtime-start";

  try {
    const router = await runtime.runPromise(HttpRouter.HttpRouter);

    const authBoundary = <A>(operation: (engine: AuthEngineService) => Promise<A>) =>
      runtime.runPromise(
        AuthEngine.use((engine) =>
          Effect.tryPromise({
            try: () => operation(engine),
            catch: () => new Cause.UnknownError(undefined, "candidate auth operation failed"),
          }),
        ),
      );

    const auth: BackendAuthHandler = {
      handle: (request, context) => authBoundary((engine) => engine.handler(request, context)),
      recordTrustedOriginRejection: (context, flow) =>
        authBoundary((engine) => engine.recordTrustedOriginRejection(context, flow)),
    };

    const api = backendHttpHandler(
      HttpEffect.toWebHandler(router.asHttpEffect()),
      auth,
      config.sessionBoundary,
    );

    const request = (path: string, cookie?: string, body?: Schema.Json, authorization?: string) => {
      const headers = new Headers({ origin: dashboardOrigin });

      if (cookie !== undefined) headers.set("cookie", cookie);

      if (body !== undefined) headers.set("content-type", "application/json");

      if (authorization !== undefined) headers.set("authorization", authorization);

      const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers };

      if (body !== undefined) init.body = JSON.stringify(body);

      return api.fetch(new Request(backendOrigin + path, init));
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
      const result = await json(
        `${label}-own-profile`,
        "/api/profile",
        UserProfileResponse,
        cookies[label],
      );

      const identity = input.identities[label];
      assert.equal(result.personId, identity.personId);
      assert.equal(result.firstName, identity.firstName);
      assert.equal(result.lastName, identity.lastName);
      assert.equal(result.email, identity.email);
      assert.equal(result.role, label === "member" ? "ROLE_TEAM_MEMBER" : "ROLE_TEAM_LEADER");
      checks.push(phase);
    }

    await status(
      "historical-profile-authority-denied",
      "/api/profile",
      403,
      cookies.historicalLeader,
    );
    await status("anonymous-profile-denied", "/api/profile", 401);

    for (const label of ["leader", "member", "historicalLeader", "otherDepartment"] as const) {
      const scopes = await json(
        `${label}-native-scope`,
        "/api/placements/scopes",
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
      `/api/mailing-lists?${new URLSearchParams({ type: "assistants", department, semester: input.scope.semesterId })}`;

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

    const affiliationPath = `/api/placements/affiliation?${new URLSearchParams({ departmentId: input.scope.departmentId })}`;

    const ownAffiliation = await json(
      "member-imported-affiliation",
      affiliationPath,
      OwnAffiliationResource,
      cookies.member,
    );

    assert.equal(ownAffiliation.personId, input.identities.member.personId);
    assert.equal(ownAffiliation.status, "Active");
    checks.push(phase);

    const foreignAffiliation = await json(
      "other-affiliation-isolation",
      affiliationPath,
      OwnAffiliationResource,
      cookies.otherDepartment,
    );

    assert.equal(foreignAffiliation.personId, input.identities.otherDepartment.personId);
    assert.equal(foreignAffiliation.status, "Absent");
    checks.push(phase);
    await status(
      "affiliation-person-override-rejected",
      `${affiliationPath}&personId=${encodeURIComponent(input.identities.member.personId)}`,
      400,
      cookies.otherDepartment,
    );

    const boardPath = (departmentId: string) =>
      `/api/placements?${new URLSearchParams({ departmentId, semesterId: input.scope.semesterId })}`;

    const board = await json(
      "leader-imported-placement",
      boardPath(input.scope.departmentId),
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
    await status(
      "leader-other-placement-scope-denied",
      boardPath(input.scope.otherDepartmentId),
      403,
      cookies.leader,
    );

    for (const label of ["member", "historicalLeader", "otherDepartment"] as const) {
      await status(
        `${label}-placement-board-denied`,
        boardPath(input.scope.departmentId),
        403,
        cookies[label],
      );
    }

    await status("anonymous-placement-denied", boardPath(input.scope.departmentId), 401);

    assert.equal(input.receipt.ownerPersonId, input.identities.member.personId);

    for (const label of ["leader", "member", "historicalLeader", "otherDepartment"] as const) {
      const receipts = await json(
        `${label}-receipt-owner-isolation`,
        "/api/receipts",
        ReceiptListResponse,
        cookies[label],
      );

      assert.ok(
        receipts.items.every((item) => item.ownerPersonId === input.identities[label].personId),
      );
      assert.equal(
        receipts.items.some((item) => item.receiptId === input.receipt.receiptId),
        label === "member",
      );
      checks.push(phase);
    }

    const filePath = `/api/receipts/${encodeURIComponent(input.receipt.receiptId)}/file`;
    phase = "owner-private-receipt-bytes";
    const downloaded = await request(filePath, cookies.member);
    assert.equal(downloaded.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await downloaded.arrayBuffer()))
        .digest("hex"),
      input.receipt.sha256,
    );
    checks.push(phase);

    for (const label of ["leader", "historicalLeader", "otherDepartment"] as const) {
      await status(`${label}-private-receipt-denied`, filePath, 404, cookies[label]);
    }

    await status("anonymous-private-receipt-denied", filePath, 401);
    phase = "invalid-bearer-no-cookie-fallback";

    const invalidBearer = await request(
      filePath,
      cookies.member,
      undefined,
      "Bearer candidate-invalid",
    );

    assert.equal(invalidBearer.status, 401);
    await invalidBearer.body?.cancel();
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

      const afterChange = await json(
        "changed-password-same-person",
        "/api/profile",
        UserProfileResponse,
        cookies.member,
      );

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
