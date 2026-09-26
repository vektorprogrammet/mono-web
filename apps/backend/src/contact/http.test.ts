import { backendDatabase } from "../../test/database.js";
import { Database } from "@vektorprogrammet/database";
import { Organization } from "@vektorprogrammet/domain/organization";
import { NativeProblem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeBackendConfig } from "../config.js";
import { makeBackendTestHttp } from "../test/native-http.js";
import { contactConfig } from "./config.js";

const unexpectedOrganizationAccess = () => Effect.die("unexpected organization access");

const organization = Layer.mock(Organization, {
  readDepartment: unexpectedOrganizationAccess,
});

const backendConfig = decodeBackendConfig({
  BACKEND_PG_URL: "postgres://test.invalid/vektorprogrammet",
  BETTER_AUTH_SECRET: "contact-test-secret-with-at-least-32-characters!",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
});

const config = contactConfig({
  CONTACT_BACKEND_TOKEN: "backend-test-credential-0000000000000000",
  CONTACT_DELIVERY_TOKEN: "delivery-test",
  CONTACT_SENDER: "contact@example.org",
  CONTACT_DELIVERY_URL: "http://127.0.0.1:9999",
  CONTACT_DELIVERY_TIMEOUT_MS: "100",
})!;

const unavailableAuthHandler = {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  recordTrustedOriginRejection: () => Effect.void,
};

const message = {
  departmentId: "one",
  name: "Ola",
  email: "ola@example.org",
  subject: "Hei",
  message: "Hei",
};

/** The contact ingress as the homepage reaches it, with or without delivery configured. */
const contactIngress = (contact: typeof config | undefined) => {
  const database = backendDatabase();

  const http = makeBackendTestHttp(
    { ...backendConfig, contact },
    Layer.mergeAll(database.layer, organization),
    unavailableAuthHandler,
  );

  return {
    submit: (
      credentials: { readonly ip: string; readonly token: string | undefined },
      payload: Schema.Json = message,
    ) => {
      const headers = new Headers({
        "content-type": "application/json",
        origin: "http://127.0.0.1:5174",
        "x-vektor-contact-ip": credentials.ip,
      });

      if (credentials.token !== undefined) {
        headers.set("x-vektor-contact-backend", credentials.token);
      }

      return http.fetch(
        new Request("http://backend.test/api/contact-messages", {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        }),
      );
    },
    consumedWindows: () =>
      database.run(
        Database.use(
          (sql) =>
            sql<{
              count: number;
            }>`SELECT count(*)::integer AS count FROM public.contact_rate_windows`,
        ),
      ),
  };
};

const problemOf = async (response: Response) => ({
  status: response.status,
  code: Schema.decodeUnknownSync(NativeProblem)(await response.json()).code,
});

describe("native contact trust boundary", () => {
  it("rejects missing, wrong and wrong-hop tokens before quota or delivery", async () => {
    const ingress = contactIngress(config);

    for (const [token, code] of [
      [undefined, "credential.missing"],
      ["wrong", "credential.invalid"],
      ["ingress-test-credential-0000000000000000", "credential.invalid"],
    ] as const) {
      expect(await problemOf(await ingress.submit({ ip: "127.0.0.1", token }))).toEqual({
        status: 401,
        code,
      });
    }

    expect(await ingress.consumedWindows()).toEqual([{ count: 0 }]);
  });

  it("fails closed for absent configuration and noncanonical addresses before mutation", async () => {
    const unconfigured = contactIngress(undefined);

    expect(
      await problemOf(await unconfigured.submit({ ip: "127.0.0.1", token: undefined })),
    ).toEqual({ status: 503, code: "contact.unavailable" });

    const ingress = contactIngress(config);

    for (const ip of ["", "::ffff:127.0.0.1", "127.0.0.1/32", "127.0.0.1,127.0.0.2"]) {
      expect(await problemOf(await ingress.submit({ ip, token: config.backendToken }))).toEqual({
        status: 400,
        code: "header.malformed",
      });
    }

    expect(await ingress.consumedWindows()).toEqual([{ count: 0 }]);
  });

  it("rejects schema invalid and injected recipient before quota", async () => {
    const ingress = contactIngress(config);

    const credentials = { ip: "127.0.0.1", token: config.backendToken };

    for (const payload of [
      { ...message, email: "malformed" },
      { ...message, to: "attacker@example.org" },
      { ...message, subject: "Hei\r\nBcc: bad" },
    ]) {
      expect(await problemOf(await ingress.submit(credentials, payload))).toEqual({
        status: 422,
        code: "validation.failed",
      });
    }

    expect(await ingress.consumedWindows()).toEqual([{ count: 0 }]);
  });
});
