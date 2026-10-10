import { assert, layer } from "@effect/vitest";
import { Cause, Crypto, Effect, Exit, Layer, PlatformError } from "effect";
import { decodeAdmissionApiConfig } from "./admission/config.js";
import { allocateBase64UrlToken, allocatePrefixedUuid } from "./allocation.js";
import { decodeReceiptApiConfig } from "./receipt/config.js";
import { recruitmentApiConfig } from "./recruitment/config.js";
import { TestPlatform } from "./test/platform.js";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Bytes 3, 11, 19, ...: not a UUID fixed point, and every base64url character class occurs. */
const entropyBytes = (size: number) =>
  Uint8Array.from({ length: size }, (_, index) => (index * 8 + 3) % 256);

/** The UUIDv4 that `entropyBytes(16)` formats to: version nibble 4 and variant bits 10. */
const entropyUuid = "030b131b-232b-433b-834b-535b636b737b";

/** The base64url text of `entropyBytes(32)`, from `Buffer.toString("base64url")` as an independent oracle. */
const entropyToken = "AwsTGyMrMztDS1NbY2tze4OLk5ujq7O7w8vT2-Pr8_s";

const primitives = {
  randomBytes: entropyBytes,
  digest: () => Effect.die("Allocation computes no digest."),
};

const admission = decodeAdmissionApiConfig({});

const recruitment = recruitmentApiConfig(admission);

const receipt = decodeReceiptApiConfig({});

layer(Layer.succeed(Crypto.Crypto, Crypto.make(primitives)), { excludeTestServices: true })(
  "allocation over fixed entropy",
  (it) => {
    it.effect("formats prefixed identifiers from the UUIDv4 of the Crypto service", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* allocatePrefixedUuid("receipt"), `receipt_${entropyUuid}`);
      }),
    );

    it.effect("encodes tokens as unpadded base64url of the drawn bytes", () =>
      Effect.gen(function* () {
        const token = yield* allocateBase64UrlToken(32);

        assert.strictEqual(token, entropyToken);
        assert.strictEqual(token.length, 43);
      }),
    );

    it.effect("gives every config allocator its prefix and the draw of the Crypto service", () =>
      Effect.gen(function* () {
        const ids = yield* Effect.all({
          period: admission.nextAdmissionPeriodId,
          applicant: admission.nextApplicantId,
          application: admission.nextApplicationId,
          interview: recruitment.nextInterviewId,
          invitation: recruitment.nextInvitationId,
          receipt: receipt.nextReceiptId,
          visual: receipt.nextVisualId,
        });

        assert.deepStrictEqual(ids, {
          period: `admission_period_${entropyUuid}`,
          applicant: `applicant_${entropyUuid}`,
          application: `application_${entropyUuid}`,
          interview: `recruitment_interview_${entropyUuid}`,
          invitation: `recruitment_invitation_${entropyUuid}`,
          receipt: `receipt_${entropyUuid}`,
          visual: `visual_${entropyUuid}`,
        });

        assert.strictEqual(yield* admission.nextActivationToken, entropyToken);
        assert.strictEqual(yield* recruitment.nextResponseCapability, entropyToken);
      }),
    );
  },
);

layer(TestPlatform, { excludeTestServices: true })("allocation over platform entropy", (it) => {
  it.effect("draws a fresh UUIDv4 and a fresh 43-character token on every run", () =>
    Effect.gen(function* () {
      const applicants = yield* Effect.all([admission.nextApplicantId, admission.nextApplicantId]);

      const tokens = yield* Effect.all([
        admission.nextActivationToken,
        admission.nextActivationToken,
      ]);

      for (const applicant of applicants)
        assert.match(applicant, new RegExp(`^applicant_${uuidV4}$`));

      for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);

      assert.notStrictEqual(applicants[0], applicants[1]);
      assert.notStrictEqual(tokens[0], tokens[1]);
    }),
  );
});

const unavailable = PlatformError.badArgument({
  module: "Crypto",
  method: "randomBytes",
  description: "entropy source unavailable",
});

/** The platform entropy source failed: UUID and byte draws both fail with a PlatformError. */
const failingEntropy = {
  ...Crypto.make(primitives),
  randomBytes: () => Effect.fail(unavailable),
  randomUUIDv4: Effect.fail(unavailable),
};

layer(Layer.succeed(Crypto.Crypto, failingEntropy), { excludeTestServices: true })(
  "allocation over failing entropy",
  (it) => {
    it.effect("makes a platform entropy failure a defect, never a typed failure", () =>
      Effect.gen(function* () {
        const exits = yield* Effect.all([
          Effect.exit(allocatePrefixedUuid("receipt")),
          Effect.exit(allocateBase64UrlToken(32)),
          Effect.exit(admission.nextApplicantId),
          Effect.exit(recruitment.nextResponseCapability),
        ]);

        for (const exit of exits) {
          assert.isTrue(Exit.isFailure(exit));

          if (Exit.isFailure(exit)) {
            assert.isTrue(Cause.hasDies(exit.cause));
            assert.isFalse(Cause.hasFails(exit.cause));
          }
        }
      }),
    );
  },
);
