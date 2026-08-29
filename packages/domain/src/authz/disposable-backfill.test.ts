import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { canonicalJsonBytes } from "../tutor/evidence.js";
import { authorDisposableAuthzBackfill } from "./disposable-backfill.js";

const startAt = "2032-01-01T00:00:00.000Z";

const validAuthoring = () => ({
  disposable: true,
  tags: [{ name: "Receipt delegates" }, { name: "Payment delegates" }],
  assignments: [
    {
      tagName: "Receipt delegates",
      personId: "authz-backfill-person-b",
      startAt,
      endAt: null,
    },
    {
      tagName: "Payment delegates",
      personId: "authz-backfill-person-a",
      startAt,
      endAt: null,
    },
  ],
  rulesBySubject: [
    {
      subject: { _tag: "Tag", tagName: "Payment delegates" },
      rules: [
        {
          capabilityId: "submitReceipt",
          effectKind: "delegate",
          scope: { _tag: "Receipt" },
          params: {
            paymentAccountCiphertext: "ciphertext-disposable-payment",
            slot: "EconomyPaymentAuthority",
          },
          startAt,
          endAt: null,
        },
      ],
    },
    {
      subject: { _tag: "Person", personId: "authz-backfill-person-a" },
      rules: [
        {
          capabilityId: "approveReceipt",
          effectKind: "delegate",
          scope: { _tag: "Department", departmentId: "authz-backfill-department" },
          params: { slot: "EconomyDepartmentApprovalGrant" },
          startAt,
          endAt: null,
        },
        {
          capabilityId: "approveReceipt",
          effectKind: "delegate",
          scope: { _tag: "Receipt" },
          params: { slot: "EconomyGlobalReceiptApprovalGrant" },
          startAt,
          endAt: null,
        },
      ],
    },
  ],
});

const reversedAuthoring = () => {
  const input = validAuthoring();
  return {
    ...input,
    tags: [...input.tags].reverse(),
    assignments: [...input.assignments].reverse(),
    rulesBySubject: [...input.rulesBySubject]
      .reverse()
      .map((group) => ({ ...group, rules: [...group.rules].reverse() })),
  };
};

describe("disposable authorization backfill authoring", () => {
  it.effect("authors byte-identical stable rows for reversed input order", () =>
    Effect.gen(function* () {
      const forward = yield* authorDisposableAuthzBackfill(validAuthoring());
      const reverse = yield* authorDisposableAuthzBackfill(reversedAuthoring());

      expect(canonicalJsonBytes(reverse)).toEqual(canonicalJsonBytes(forward));
      expect(forward.tags.map((tag) => tag.tagId)).toEqual(
        forward.tags.map((tag) => tag.tagId).toSorted(),
      );
      expect(forward.assignments.map((assignment) => assignment.assignmentId)).toEqual(
        forward.assignments.map((assignment) => assignment.assignmentId).toSorted(),
      );
      for (const group of forward.rulesBySubject) {
        expect(group.rules.map((rule) => rule.ruleId)).toEqual(
          group.rules.map((rule) => rule.ruleId).toSorted(),
        );
      }
    }),
  );

  it.effect("strictly rejects unknown capabilities and invalid params", () =>
    Effect.gen(function* () {
      const input = validAuthoring();
      const personGroup = input.rulesBySubject[1];
      if (personGroup === undefined) throw new Error("missing fixture person rule group");
      const firstRule = personGroup.rules[0];
      if (firstRule === undefined) throw new Error("missing fixture rule");

      const invalidInputs: ReadonlyArray<unknown> = [
        {
          ...input,
          rulesBySubject: [
            {
              ...personGroup,
              rules: [{ ...firstRule, capabilityId: "unknownCapability" }],
            },
          ],
        },
        {
          ...input,
          rulesBySubject: [
            {
              ...personGroup,
              rules: [
                {
                  ...firstRule,
                  capabilityId: "submitReceipt",
                  params: { slot: "EconomyPaymentAuthority" },
                },
              ],
            },
          ],
        },
      ];

      for (const invalidInput of invalidInputs) {
        const failure = yield* Effect.flip(authorDisposableAuthzBackfill(invalidInput));
        expect(failure._tag).toBe("DisposableAuthzBackfillDecodeError");
      }
    }),
  );

  it.effect("rejects absent tag references before producing a plan", () =>
    Effect.gen(function* () {
      const input = validAuthoring();
      const failure = yield* Effect.flip(
        authorDisposableAuthzBackfill({
          ...input,
          tags: input.tags.filter((tag) => tag.name !== "Payment delegates"),
          assignments: input.assignments.filter(
            (assignment) => assignment.tagName !== "Payment delegates",
          ),
        }),
      );

      expect(failure).toMatchObject({
        _tag: "DisposableAuthzBackfillMissingReference",
        referenceKind: "Tag",
        referenceId: "Payment delegates",
      });
    }),
  );

  it.effect("has no production mode and requires the literal disposable marker", () =>
    Effect.gen(function* () {
      const input = validAuthoring();
      const falseMarker = yield* Effect.flip(
        authorDisposableAuthzBackfill({ ...input, disposable: false }),
      );
      const productionMode = yield* Effect.flip(
        authorDisposableAuthzBackfill({ ...input, mode: "production" }),
      );

      expect(falseMarker._tag).toBe("DisposableAuthzBackfillDecodeError");
      expect(productionMode._tag).toBe("DisposableAuthzBackfillDecodeError");
    }),
  );
});
