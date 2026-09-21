import { Database, type DatabaseShape } from "@vektorprogrammet/database";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { contactConfig } from "./config.js";
import { makeContactHandler } from "./http.js";
import { runTestPromise } from "../../test/runtime.js";

const makeDatabase = () =>
  vi.fn(() => Effect.die("contact quota should not run")) as unknown as DatabaseShape;
const handleContact = (
  request: Request,
  config: Parameters<typeof makeContactHandler>[0],
  database: DatabaseShape,
) =>
  runTestPromise(
    makeContactHandler(config)(request).pipe(Effect.provideService(Database, database)),
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
const request = (headers: Record<string, string>, payload: unknown = message) =>
  new Request("http://127.0.0.1/api/contact-messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
describe("native contact trust boundary", () => {
  it("rejects missing, wrong and wrong-hop tokens before quota or delivery", async () => {
    const database = makeDatabase();
    for (const token of [undefined, "wrong", "ingress-test-credential-0000000000000000"]) {
      const headers: Record<string, string> = { "x-vektor-contact-ip": "127.0.0.1" };
      if (token !== undefined) headers["x-vektor-contact-backend"] = token;
      expect((await handleContact(request(headers), config, database)).status).toBe(401);
    }
    expect(database).not.toHaveBeenCalled();
  });
  it("fails closed for absent configuration and noncanonical addresses before mutation", async () => {
    const database = makeDatabase();
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
    expect(database).not.toHaveBeenCalled();
  });
  it("rejects schema invalid and injected recipient before quota", async () => {
    const database = makeDatabase();
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
    expect(database).not.toHaveBeenCalled();
  });
});
