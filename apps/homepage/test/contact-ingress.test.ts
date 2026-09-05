import { describe, expect, it } from "vitest";
import { authenticateContactIngress } from "../src/lib/contact-context.server";
const env = {
  API_URL: "http://127.0.0.1:9123",
  CONTACT_INGRESS_TOKEN: "ingress-000000000000000000000000000",
  CONTACT_BACKEND_TOKEN: "backend-000000000000000000000000000",
};
const request = (token?: string, ip = "::ffff:127.0.0.1") =>
  new Request("http://homepage.test/kontakt", {
    headers: {
      ...(token ? { "x-vektor-contact-ingress": token } : {}),
      "x-vektor-contact-ip": ip,
      "x-forwarded-for": "192.0.2.99",
    },
  });
describe("homepage contact ingress authority", () => {
  it("rejects missing, wrong-hop and shared hop credentials", () => {
    expect(authenticateContactIngress(request(), env)).toBeUndefined();
    expect(authenticateContactIngress(request(env.CONTACT_BACKEND_TOKEN), env)).toBeUndefined();
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), {
        ...env,
        CONTACT_BACKEND_TOKEN: env.CONTACT_INGRESS_TOKEN,
      }),
    ).toBeUndefined();
  });
  it("canonicalizes only the authenticated declared address and rejects invalid topology", () => {
    expect(authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), env)?.visitorIp).toBe(
      "127.0.0.1",
    );
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN, "127.0.0.1/32"), env),
    ).toBeUndefined();
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), {
        ...env,
        API_URL: "http://127.0.0.1:9123/path",
      }),
    ).toBeUndefined();
  });
});
