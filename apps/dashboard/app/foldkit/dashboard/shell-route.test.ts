import { PersonId } from "@vektorprogrammet/domain/organization";
import { OwnProfileResource, StrongETag, type NativeProblemCode } from "@vektorprogrammet/rpc";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNativeRpcRequest,
  nativeRpcProblem,
  nativeRpcSuccess,
  nativeSession,
  readNativeRpcCall,
} from "../../../test/native-rpc";
import { sessionCookie } from "../../../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { dashboardShellVisibility } from "./shell";
import { loadDashboardShell } from "./shell.server";

const ownProfile = Schema.encodeSync(Schema.toCodecJson(OwnProfileResource))(
  OwnProfileResource.make({
    profile: {
      personId: PersonId.make("person-1"),
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      phone: "+47 12345678",
      role: "ROLE_TEAM_MEMBER",
      nameRevision: 0,
      contactRevision: 0,
    },
    etag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
  }),
);

/** Every backend request, as an RPC tag or an HTTP path. */
const requests: string[] = [];

let profileProblem: NativeProblemCode | undefined;

const load = () => loadDashboardShell(new Request("http://dashboard.test/dashboard/skoler", { headers: { cookie: sessionCookie } }));

beforeEach(() => {
  requests.length = 0;
  profileProblem = undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    if (!isNativeRpcRequest(input)) {
      const path = new URL(new Request(input, init).url).pathname;
      requests.push(path);

      return Response.json({ user: { name: "Member Session", email: "member@example.invalid" } });
    }

    const call = await readNativeRpcCall(input, init);
    requests.push(call.tag);

    if (call.tag === "system.readSession") return nativeRpcSuccess(call, nativeSession);

    if (call.tag === "profile.readOwnProfile") {
      return profileProblem === undefined
        ? nativeRpcSuccess(call, ownProfile)
        : nativeRpcProblem(call, profileProblem);
    }

    return nativeRpcSuccess(call, null);
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("parent dashboard authority gate", () => {
  it("keeps an authenticated authority-denied actor in a shell with session identity", async () => {
    profileProblem = "authority.denied";
    await expect(load()).resolves.toEqual({ user: { name: "Member Session", email: "member@example.invalid" }, isAdmin: false, hasOrganizationContext: false });
    expect(requests).toContain("/api/auth/get-session");
    expect(requests).not.toContain("system.deleteSession");
  });
  it("returns a canonical profile identity for an active team member", async () => {
    await expect(load()).resolves.toEqual({ user: { name: "Ada Lovelace", email: "ada@example.invalid" }, isAdmin: false, hasOrganizationContext: true });
    expect(requests).toEqual(["system.readSession", "profile.readOwnProfile"]);
  });
  it("redirects only an unauthorized profile request as expired", async () => {
    profileProblem = "credential.invalid";
    await expect(load()).rejects.toMatchObject({ status: 302 });
  });
  it("surfaces a profile infrastructure failure without dropping the session", async () => {
    profileProblem = "profile.unavailable";
    await expect(load()).rejects.toMatchObject({ status: 503 });
    expect(requests).not.toContain("system.deleteSession");
  });
});


describe("parent dashboard no-profile shell", () => {
  it("hides identity-only content and retains child route mounting", () => {
    expect(dashboardShellVisibility(null, false)).toEqual({
      showIdentityMenu: false,
      showOrganizationContext: false,
      mountChildRoutes: true,
    });
  });

  it("shows identity content for a canonical profile", () => {
    expect(
      dashboardShellVisibility({ name: "Ada Lovelace", email: "ada@example.invalid" }, true),
    ).toEqual({
      showIdentityMenu: true,
      showOrganizationContext: true,
      mountChildRoutes: true,
    });
  });

  it("keeps session identity visible without exposing organization navigation", () => {
    expect(
      dashboardShellVisibility({ name: "Member Session", email: "member@example.invalid" }, false),
    ).toEqual({
      showIdentityMenu: true,
      showOrganizationContext: false,
      mountChildRoutes: true,
    });
  });
});
