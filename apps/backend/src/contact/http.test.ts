import { backendDatabase } from "../../test/database.js";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";
import { Organization } from "@vektorprogrammet/domain/organization";
import { Schema, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { contactConfig } from "./config.js";
import { makeContactHandler } from "./http.js";
import { runTestPromise } from "../../test/runtime.js";

const unexpectedOrganizationAccess = () => Effect.die("unexpected organization access");

const organization = Organization.of({
  readDepartment: unexpectedOrganizationAccess,
  listDepartments: unexpectedOrganizationAccess(),
  readTeam: unexpectedOrganizationAccess,
  listTeams: unexpectedOrganizationAccess,
  listFieldOfStudies: unexpectedOrganizationAccess(),
  listTeamInterestRegistrations: unexpectedOrganizationAccess,
  projectMailingLists: unexpectedOrganizationAccess,
  createDepartment: unexpectedOrganizationAccess,
  createTeam: unexpectedOrganizationAccess,
  createFieldOfStudy: unexpectedOrganizationAccess,
  readMembership: unexpectedOrganizationAccess,
  listMembershipsForTeam: unexpectedOrganizationAccess,
  listHistoricalMemberships: unexpectedOrganizationAccess(),
  resolvePersonAuthority: unexpectedOrganizationAccess,
  resolvePersonAuthorityForRead: unexpectedOrganizationAccess,
  deriveDirectoryFacts: unexpectedOrganizationAccess,
  readAppointmentManagement: unexpectedOrganizationAccess,
  executeLifecycle: unexpectedOrganizationAccess,
  importLegacyOrganization: unexpectedOrganizationAccess,
});

const handleContact = (
  request: Request,
  config: Parameters<typeof makeContactHandler>[0],
  database: DatabaseOperations,
) =>
  runTestPromise(
    makeContactHandler(config)(request).pipe(
      Effect.provideService(Database, database),
      Effect.provideService(Organization, organization),
    ),
  );

const config = contactConfig({
  CONTACT_BACKEND_TOKEN: "backend-test-credential-0000000000000000",
  CONTACT_DELIVERY_TOKEN: "delivery-test",
  CONTACT_SENDER: "contact@example.org",
  CONTACT_DELIVERY_URL: "http://127.0.0.1:9999",
  CONTACT_DELIVERY_TIMEOUT_MS: "100",
})!;

const message = {
  departmentId: "one",
  name: "Ola",
  email: "ola@example.org",
  subject: "Hei",
  message: "Hei",
};

const request = (headers: Headers | Record<string, string>, payload: Schema.Json = message) => {
  const combined = new Headers(headers);
  combined.set("content-type", "application/json");

  return new Request("http://127.0.0.1/api/contact-messages", {
    method: "POST",
    headers: combined,
    body: JSON.stringify(payload),
  });
};

describe("native contact trust boundary", () => {
  it("rejects missing, wrong and wrong-hop tokens before quota or delivery", async () => {
    const database = await backendDatabase().run(Database);

    for (const token of [undefined, "wrong", "ingress-test-credential-0000000000000000"]) {
      const headers = new Headers({ "x-vektor-contact-ip": "127.0.0.1" });

      if (token !== undefined) headers.set("x-vektor-contact-backend", token);
      expect((await handleContact(request(headers), config, database)).status).toBe(401);
    }

    expect(
      await runTestPromise(
        database<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM public.contact_rate_windows`,
      ),
    ).toEqual([{ count: 0 }]);
  });
  it("fails closed for absent configuration and noncanonical addresses before mutation", async () => {
    const database = await backendDatabase().run(Database);
    expect((await handleContact(request({}), undefined, database)).status).toBe(503);

    for (const ip of ["", "::ffff:127.0.0.1", "127.0.0.1/32", "127.0.0.1,127.0.0.2"]) {
      expect(
        (
          await handleContact(
            request({ "x-vektor-contact-backend": config.backendToken, "x-vektor-contact-ip": ip }),
            config,
            database,
          )
        ).status,
      ).toBe(401);
    }

    expect(
      await runTestPromise(
        database<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM public.contact_rate_windows`,
      ),
    ).toEqual([{ count: 0 }]);
  });
  it("rejects schema invalid and injected recipient before quota", async () => {
    const database = await backendDatabase().run(Database);

    const headers = {
      "x-vektor-contact-backend": config.backendToken,
      "x-vektor-contact-ip": "127.0.0.1",
    };

    for (const payload of [
      { ...message, email: "malformed" },
      { ...message, to: "attacker@example.org" },
      { ...message, subject: "Hei\r\nBcc: bad" },
    ])
      expect((await handleContact(request(headers, payload), config, database)).status).toBe(422);
    expect(
      await runTestPromise(
        database<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM public.contact_rate_windows`,
      ),
    ).toEqual([{ count: 0 }]);
  });
});
