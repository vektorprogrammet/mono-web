import { makeNativeProblem, makeNativeValidationError } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import { nativeProblemFrom } from "./native-problem";
import {
  isAdmissionPeriodUnauthorizedError,
  mapAdmissionPeriodError,
} from "./admission-period-view";
import { isUnauthorizedError, mapOwnedReceiptError, mapApprovalReceiptError } from "./receipt-view";

const envelope = (body: unknown) => ({
  body,
  headers: { "cache-control": "no-store", vary: "Origin" },
});
const validation = (pointer: string) => ({
  ...makeNativeProblem("validation.failed"),
  validation: { errors: [makeNativeValidationError(pointer, "invalid")], truncated: false },
});

describe("canonical SDK problem projection", () => {
  it("preserves authorization and conflict decisions through the SDK response envelope", () => {
    const denied = envelope(makeNativeProblem("credential.invalid"));
    expect(isAdmissionPeriodUnauthorizedError(denied)).toBe(true);
    expect(isUnauthorizedError(denied)).toBe(true);
    const stale = envelope(makeNativeProblem("precondition.failed"));
    expect(mapAdmissionPeriodError(stale)._tag).toBe("StaleAdmissionPeriodRevision");
    expect(mapOwnedReceiptError(stale)._tag).toBe("StaleReceiptRevision");
    expect(mapApprovalReceiptError(stale)._tag).toBe("StaleReceiptRevision");
  });
  it("preserves canonical validation pointers for existing field messages", () => {
    expect(mapAdmissionPeriodError(envelope(validation("/endAt"))).field).toBe("endAt");
    expect(mapOwnedReceiptError(envelope(validation("/amountOre"))).field).toBe("amountNok");
    expect(nativeProblemFrom(validation("/file"))).toEqual(
      nativeProblemFrom(envelope(validation("/file"))),
    );
  });
  it("does not turn arbitrary error-like objects or malformed validation into authority decisions", () => {
    expect(
      nativeProblemFrom(envelope({ code: "credential.invalid", status: 401 })),
    ).toBeUndefined();
    expect(
      nativeProblemFrom(envelope({ ...validation("/file"), validation: { errors: "invalid" } })),
    ).toBeUndefined();
  });
});
