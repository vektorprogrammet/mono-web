import { DepartmentNotFound } from "../organization/errors.js";
import { DepartmentId } from "../organization/schema.js";
import { Organization } from "../organization/service.js";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { canonicalContactIp, ContactMessage, ContactVisitorIp } from "./schema.js";
import { ContactDelivery, ContactFailure, ContactQuota, submitContact } from "./service.js";

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

/**
 * One submission for the visitor `127.0.0.1` against capabilities that record, in order, what they
 * were asked. The quota answers with `quota`, and the recipient department does not exist.
 */
const submission = (quota: Effect.Effect<void, ContactFailure>) => {
  const used: Array<string> = [];

  const record = (entry: string) =>
    Effect.sync(() => {
      used.push(entry);
    });

  const services = Layer.mergeAll(
    Layer.succeed(
      ContactQuota,
      ContactQuota.of({ consume: (ip) => record(`quota ${ip}`).pipe(Effect.andThen(quota)) }),
    ),
    Layer.mock(Organization, {
      readDepartment: (departmentId) =>
        record(`department ${departmentId}`).pipe(
          Effect.andThen(Effect.fail(new DepartmentNotFound({ departmentId }))),
        ),
    }),
    Layer.mock(ContactDelivery, { send: () => record("delivery") }),
  );

  return {
    used,
    failure: submitContact(valid, ContactVisitorIp.make("127.0.0.1")).pipe(
      Effect.provide(services),
      Effect.flip,
    ),
  };
};

describe("contact submission order", () => {
  it.effect(
    "commits the quota attempt before the recipient lookup, so a missing recipient refunds nothing",
    () =>
      Effect.gen(function* () {
        const { used, failure } = submission(Effect.void);

        expect((yield* failure).reason).toBe("InvalidRecipient");
        // The quota has no operation that gives an attempt back, so the one it was asked for stands.
        expect(used).toEqual(["quota 127.0.0.1", "department one"]);
      }),
  );

  it.effect("stops at a spent quota before any recipient lookup or delivery", () =>
    Effect.gen(function* () {
      const { used, failure } = submission(
        Effect.fail(new ContactFailure({ reason: "RateLimited" })),
      );

      expect((yield* failure).reason).toBe("RateLimited");
      expect(used).toEqual(["quota 127.0.0.1"]);
    }),
  );
});
