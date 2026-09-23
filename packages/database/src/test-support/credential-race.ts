import assert from "node:assert/strict";
import type { Pool } from "pg";
import { createLocalAccountIssuer } from "better-auth";
import type { AuthEngine } from "../auth-engine.js";
import { nativePasswordHash } from "../password-codec.js";

/** Real engine/database regression: reset completes after verification but before session creation. */
export const proveCredentialResetRace = async (input: {
  readonly engine: AuthEngine;
  readonly pool: Pool;
  readonly legacyHash: string;
  readonly password: string;
  readonly resetPassword: string;
  readonly origin: string;
  readonly reset: (email: string) => Promise<void>;
}) => {
  const context = await input.engine.$context;
  const originalCreate = context.internalAdapter.createSession;
  const nativeHash = await nativePasswordHash(input.password);
  for (const [id, hash] of [
    ["race-legacy", input.legacyHash],
    ["race-native", nativeHash],
  ]) {
    const personId = id!;
    const email = `${personId}@example.invalid`;
    await input.pool.query(
      "INSERT INTO public.person_profiles(person_id,first_name,last_name) VALUES($1,'Synthetic','Credential')",
      [personId],
    );
    await context.internalAdapter.createUser(
      { id: personId, name: "Synthetic Credential", email, emailVerified: true },
      { method: "email-password" },
    );
    await context.internalAdapter.linkAccount({
      accountId: personId,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      userId: personId,
      password: hash!,
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => reached.reject(new Error("Credential race barrier timed out")),
      10_000,
    );
    context.internalAdapter.createSession = async (...args) => {
      if (args[0] === personId) {
        reached.resolve();
        await release.promise;
      }
      return originalCreate(...args);
    };
    const login = (password: string) =>
      input.engine.api.signInEmail({
        body: { email, password },
        headers: new Headers({ origin: input.origin }),
        asResponse: true,
      });
    const staleLogin = login(input.password);
    let resetHash: string;
    try {
      await reached.promise;
      await input.reset(email);
      resetHash = (
        await input.pool.query('SELECT password FROM auth."account" WHERE "userId"=$1', [personId])
      ).rows[0].password;
    } finally {
      clearTimeout(timer);
      release.resolve();
      context.internalAdapter.createSession = originalCreate;
    }
    const response = await staleLogin;
    assert.equal(response.status, 401, "stale verified password cannot authenticate");
    const cookies = response.headers.getSetCookie();
    assert.ok(
      cookies.length > 0 && cookies.every((value) => /Max-Age=0/iu.test(value)),
      "no live Set-Cookie survives",
    );
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    assert.equal(
      await input.engine.api.getSession({ headers: new Headers({ cookie }) }),
      null,
      "stale cookie cannot resolve a session",
    );
    assert.equal(
      (
        await input.pool.query('SELECT count(*)::int n FROM auth."session" WHERE "userId"=$1', [
          personId,
        ])
      ).rows[0].n,
      0,
      "stale new session removed from database",
    );
    assert.ok(
      (await input.pool.query('SELECT password FROM auth."account" WHERE "userId"=$1', [personId]))
        .rows[0].password === resetHash,
      "reset hash wins stale upgrade",
    );
    assert.equal((await login(input.password)).status, 401, "old password remains denied");
    assert.equal((await login(input.resetPassword)).status, 200, "reset password remains usable");
  }
};
