import { DepartmentId } from "../organization/schema.js";
import { describe, expect, it } from "vitest";
import { Option, Schema } from "effect";
import { canonicalContactIp, ContactMessage, ContactVisitorIp } from "./schema.js";

const valid = {
  departmentId: DepartmentId.make("one"),
  name: "Ola",
  email: "ola@example.org",
  subject: "Hei",
  message: "Hei\nKontakt oss",
};

describe("contact command boundary", () => {
  it("does not permit private message text to become header controls or exceed legacy message bounds", () => {
    expect(Schema.is(ContactMessage)(valid)).toBe(true);

    for (const patch of [
      { email: "not-email" },
      { name: "Ola\r\nBcc: victim@example.org" },
      { subject: "Hei\nBcc: victim" },
      { message: "x".repeat(5001) },
      { message: "\u0000" },
      { departmentId: "" },
    ]) {
      expect(Schema.is(ContactMessage)({ ...valid, ...patch })).toBe(false);
    }
  });
  it("one address has one identity including mapped IPv4 spellings", () => {
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1"])
      expect(canonicalContactIp(ip)).toEqual(Option.some("127.0.0.1"));
    expect(canonicalContactIp("2001:0DB8:0:0:0:0:0:1")).toEqual(Option.some("2001:db8::1"));

    for (const ip of [
      "127.0.0.1/32",
      "::1%lo",
      "127.0.0.1,127.0.0.2",
      "",
      "[::1]",
      "127.0.0.1:443",
      " 127.0.0.1",
    ])
      expect(canonicalContactIp(ip)).toEqual(Option.none());
    expect(Schema.is(ContactVisitorIp)("::ffff:127.0.0.1")).toBe(false);
  });
});
