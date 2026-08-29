export const disposableAuthzBackfillStartAt = "2032-01-01T00:00:00.000Z";

export const validDisposableAuthzBackfillInput = () => ({
  disposable: true as const,
  tags: [{ name: "Disposable approvers" }, { name: "Disposable payers" }],
  assignments: [
    {
      tagName: "Disposable approvers",
      personId: "authz-backfill-person-b",
      startAt: disposableAuthzBackfillStartAt,
      endAt: null,
    },
    {
      tagName: "Disposable payers",
      personId: "authz-backfill-person-a",
      startAt: disposableAuthzBackfillStartAt,
      endAt: null,
    },
  ],
  rulesBySubject: [
    {
      subject: { _tag: "Tag" as const, tagName: "Disposable payers" },
      rules: [
        {
          capabilityId: "submitReceipt" as const,
          effectKind: "delegate" as const,
          scope: { _tag: "Receipt" as const },
          params: {
            slot: "EconomyPaymentAuthority" as const,
            paymentAccountCiphertext: "ciphertext-disposable-payer",
          },
          startAt: disposableAuthzBackfillStartAt,
          endAt: null,
        },
      ],
    },
    {
      subject: { _tag: "Person" as const, personId: "authz-backfill-person-a" },
      rules: [
        {
          capabilityId: "approveReceipt" as const,
          effectKind: "delegate" as const,
          scope: {
            _tag: "Department" as const,
            departmentId: "authz-backfill-department",
          },
          params: { slot: "EconomyDepartmentApprovalGrant" as const },
          startAt: disposableAuthzBackfillStartAt,
          endAt: null,
        },
        {
          capabilityId: "approveReceipt" as const,
          effectKind: "delegate" as const,
          scope: { _tag: "Receipt" as const },
          params: { slot: "EconomyGlobalReceiptApprovalGrant" as const },
          startAt: disposableAuthzBackfillStartAt,
          endAt: null,
        },
      ],
    },
  ],
});

export const reversedDisposableAuthzBackfillInput = () => {
  const input = validDisposableAuthzBackfillInput();
  return {
    ...input,
    tags: [...input.tags].reverse(),
    assignments: [...input.assignments].reverse(),
    rulesBySubject: [...input.rulesBySubject]
      .reverse()
      .map((group) => ({ ...group, rules: [...group.rules].reverse() })),
  };
};
