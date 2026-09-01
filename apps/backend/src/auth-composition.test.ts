import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const mainSource = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const authoritySource = await readFile(new URL("./authority.ts", import.meta.url), "utf8");
const routerSource = await readFile(new URL("./router.ts", import.meta.url), "utf8");
const authLiveSource = await readFile(
  new URL("../../../packages/database/src/auth-live.ts", import.meta.url),
  "utf8",
);
const databaseIndexSource = await readFile(
  new URL("../../../packages/database/src/index.ts", import.meta.url),
  "utf8",
);

describe("backend identity composition", () => {
  it("uses AuthLive as the sole identity authority and lifecycle owner", () => {
    expect(routerSource).toContain('from "@vektorprogrammet/domain/identity"');
    expect(mainSource).toContain(
      "const authLayers = AuthLive(config.auth).pipe(Layer.provide(databaseLayer));",
    );
    expect(routerSource).toContain("| Identity");
    expect(mainSource.match(/\bAuthLive\(config\.auth\)/g)).toHaveLength(1);
    expect(mainSource).not.toContain("AuthEngineLive");
    expect(mainSource).not.toMatch(/Layer\.merge\(AuthLive\(config\.auth\)/);
    expect(authLiveSource).not.toContain("export const AuthEngineLive");
    expect(databaseIndexSource).not.toContain("AuthEngineLive");
  });

  it("constructs one engine for the Identity, snapshot, and AuthEngine services", () => {
    const authLiveBody = authLiveSource.slice(authLiveSource.indexOf("export const AuthLive"));
    expect(authLiveBody.match(/makeAuthEngine\(config, pool\)/g)).toHaveLength(1);
    expect(authLiveBody).toContain("Context.make(Identity");
    expect(authLiveBody).toContain("Context.make(AuthEngine");
    expect(authLiveBody).toContain("Context.make(IdentitySnapshot");
  });

  it("keeps production authority code on Identity, never the engine or legacy Auth service", () => {
    expect(authoritySource).toContain('from "@vektorprogrammet/domain/identity"');
    expect(authoritySource).toContain("Identity.use");
    expect(authoritySource).not.toMatch(/from ["']@vektorprogrammet\/domain\/auth["']/);
    expect(authoritySource).not.toMatch(/\bAuth\.use/);
    expect(authoritySource).not.toMatch(/as unknown as PersonId/);
  });
});
