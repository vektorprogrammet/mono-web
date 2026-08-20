import { describe, expect, it } from "vitest";
import { createAuthCookie } from "./auth.server";

describe("createAuthCookie", () => {
  it("does not mark a loopback HTTP cookie as Secure", () => {
    const cookie = createAuthCookie(
      "token",
      new Request("http://127.0.0.1:5174/login"),
    );

    expect(cookie).not.toContain("; Secure");
  });

  it("marks an HTTPS cookie as Secure", () => {
    const cookie = createAuthCookie(
      "token",
      new Request("https://dashboard.example/login"),
    );

    expect(cookie).toContain("; Secure");
  });
});
