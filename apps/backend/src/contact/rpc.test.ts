import { describe, expect, it } from "@effect/vitest";
import { Database } from "@vektorprogrammet/database";
import { ContactMessage } from "@vektorprogrammet/domain/contact";
import {
  DepartmentId,
  DepartmentNotFound,
  Organization,
} from "@vektorprogrammet/domain/organization";
import { nativeRpcPath } from "@vektorprogrammet/rpc";
import { isProblem } from "@vektorprogrammet/rpc/problem";
import { Effect, Layer, Schema } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { backendDatabase } from "../../test/database.js";
import { backendTestConfig } from "../../test/config.js";
import { makeBackendTestRpc } from "../test/native-rpc.js";
import { contactConfig } from "./config.js";

const config = contactConfig({
  CONTACT_BACKEND_TOKEN: "backend-test-credential-0000000000000000",
  CONTACT_DELIVERY_TOKEN: "delivery-test",
  CONTACT_SENDER: "contact@example.org",
  CONTACT_DELIVERY_URL: "http://127.0.0.1:9999",
  CONTACT_DELIVERY_TIMEOUT_MS: "100",
})!;

const message = ContactMessage.make({
  departmentId: DepartmentId.make("one"),
  name: "Ola",
  email: "ola@example.org",
  subject: "Hei",
  message: "Hei",
});

/** An Organization in which no department can receive a message, so no delivery is attempted. */
const organization = Layer.mock(Organization, {
  readDepartment: (departmentId) => Effect.fail(DepartmentNotFound.make({ departmentId })),
});

/** The contact RPC as the homepage server reaches it, with or without delivery configured. */
const contactIngress = (contact: typeof config | undefined) => {
  const database = backendDatabase();

  const backend = makeBackendTestRpc({
    config: { ...backendTestConfig, contact },
    services: Layer.mergeAll(database.layer, organization),
  });

  return {
    backend,
    submit: (credentials: { readonly ip: string; readonly token: string | undefined }) => {
      const ip = { "x-vektor-contact-ip": credentials.ip };

      const headers =
        credentials.token === undefined
          ? ip
          : { ...ip, "x-vektor-contact-backend": credentials.token };

      return Effect.flatMap(backend.client, (client) =>
        client["contact.submitContactMessage"](message).pipe(
          RpcClient.withHeaders(headers),
          Effect.flip,
          Effect.map((failure) => (isProblem(failure) ? failure.code : failure)),
        ),
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

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const RpcExit = Schema.Array(
  Schema.TaggedStruct("Exit", {
    requestId: Schema.String,
    exit: Schema.TaggedStruct("Failure", {
      cause: Schema.Array(Schema.TaggedStruct("Die", { defect: Schema.Json })),
    }),
  }),
);

describe("contact.submitContactMessage", () => {
  it.live("rejects missing, wrong and wrong-hop tokens before quota or delivery", () =>
    Effect.gen(function* () {
      const ingress = contactIngress(config);

      for (const [token, code] of [
        [undefined, "credential.missing"],
        ["wrong", "credential.invalid"],
        ["ingress-test-credential-0000000000000000", "credential.invalid"],
      ] as const) {
        expect(yield* ingress.submit({ ip: "127.0.0.1", token })).toBe(code);
      }

      expect(yield* ingress.consumedWindows()).toEqual([{ count: 0 }]);
    }),
  );

  it.live("fails closed for absent configuration and noncanonical addresses before mutation", () =>
    Effect.gen(function* () {
      const unconfigured = contactIngress(undefined);

      expect(yield* unconfigured.submit({ ip: "127.0.0.1", token: undefined })).toBe(
        "contact.unavailable",
      );

      const ingress = contactIngress(config);

      for (const ip of ["", "::ffff:127.0.0.1", "127.0.0.1/32", "127.0.0.1,127.0.0.2"]) {
        expect(yield* ingress.submit({ ip, token: config.backendToken })).toBe("header.malformed");
      }

      expect(yield* ingress.consumedWindows()).toEqual([{ count: 0 }]);
    }),
  );

  it.live("refuses a message that fails the contract schema before quota", () =>
    Effect.gen(function* () {
      const ingress = contactIngress(config);

      for (const payload of [
        { ...message, email: "malformed" },
        { ...message, subject: "Hei\r\nBcc: bad" },
      ]) {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(RpcRequest))(
          RpcRequest.make({
            id: "1",
            tag: "contact.submitContactMessage",
            payload,
            headers: [
              ["x-vektor-contact-ip", "127.0.0.1"],
              ["x-vektor-contact-backend", config.backendToken],
            ],
          }),
        );

        const response = yield* ingress.backend.fetch(
          new Request(`http://native-rpc.test${nativeRpcPath}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://127.0.0.1:5174" },
            body,
          }),
        );

        // The RPC server answers an undecodable payload as a defect of that request.
        const answer = yield* Schema.decodeUnknownEffect(RpcExit)(
          yield* Effect.promise(() => response.json()),
        );

        expect(answer).toHaveLength(1);
      }

      expect(yield* ingress.consumedWindows()).toEqual([{ count: 0 }]);
    }),
  );

  it.live("keeps five attempts per visitor window, whatever each attempt answers", () =>
    Effect.gen(function* () {
      const ingress = contactIngress(config);
      const credentials = { ip: "127.0.0.1", token: config.backendToken };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        // The unknown department cannot receive the message, after the attempt counted.
        expect(yield* ingress.submit(credentials)).toBe("validation.failed");
      }

      expect(yield* ingress.submit(credentials)).toBe("rate-limit.exceeded");
      expect(yield* ingress.submit({ ...credentials, ip: "127.0.0.2" })).toBe("validation.failed");
    }),
  );
});
