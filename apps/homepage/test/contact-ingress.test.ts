import { describe, expect, it } from "vitest";
import { authenticateContactIngress } from "../src/lib/contact-context.server";

const env = {
  API_URL: "http://127.0.0.1:9123",
  CONTACT_INGRESS_TOKEN: "ingress-000000000000000000000000000",
  CONTACT_BACKEND_TOKEN: "backend-000000000000000000000000000",
};

const request = (token?: string, ip = "::ffff:127.0.0.1") =>
  {
const nativeHeaders = new Headers();

if (token) {
nativeHeaders.set("x-vektor-contact-ingress", token);
}

nativeHeaders.set("x-vektor-contact-ip", ip);
nativeHeaders.set("x-forwarded-for", "192.0.2.99");

return new Request("http://homepage.test/kontakt", {
    headers: nativeHeaders,
  });
};

describe("homepage contact ingress authority", () => {
  it("rejects missing, wrong-hop and shared hop credentials", () => {
    expect(authenticateContactIngress(request(), env)).toBeNull();
    expect(authenticateContactIngress(request(env.CONTACT_BACKEND_TOKEN), env)).toBeNull();
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), {
        ...env,
        CONTACT_BACKEND_TOKEN: env.CONTACT_INGRESS_TOKEN,
      }),
    ).toBeNull();
  });
  it("canonicalizes only the authenticated declared address and rejects invalid topology", () => {
    expect(authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), env)?.visitorIp).toBe(
      "127.0.0.1",
    );
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN, "127.0.0.1/32"), env),
    ).toBeNull();
    expect(
      authenticateContactIngress(request(env.CONTACT_INGRESS_TOKEN), {
        ...env,
        API_URL: "http://127.0.0.1:9123/path",
      }),
    ).toBeNull();
  });
});
