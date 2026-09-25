import {
  makeNativeProblem,
  makeNativeValidationError,
  type NativeProblemCode,
  Problem,
} from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import { nativeFailureFrom, nativeProblemFrom } from "./native-problem";
import {
  isAdmissionPeriodUnauthorizedError,
  mapAdmissionPeriodError,
} from "./admission-period-view";
import { isUnauthorizedError, mapOwnedReceiptError, mapApprovalReceiptError } from "./receipt-view";

/** The value the generated SDK fails with after decoding a declared problem response. */
const sdkProblem = (code: NativeProblemCode) => Problem.fromWire({ code }, {});

const validation = (pointer: string) => ({
  ...makeNativeProblem("validation.failed"),
  validation: { errors: [makeNativeValidationError(pointer, "invalid")], truncated: false },
});

describe("canonical SDK problem projection", () => {
  it("preserves authorization and conflict decisions through the SDK problem value", () => {
    const denied = sdkProblem("credential.invalid");
    expect(isAdmissionPeriodUnauthorizedError(denied)).toBe(true);
    expect(isUnauthorizedError(denied)).toBe(true);
    const stale = sdkProblem("precondition.failed");
    expect(mapAdmissionPeriodError(stale)._tag).toBe("StaleAdmissionPeriodRevision");
    expect(mapOwnedReceiptError(stale)._tag).toBe("StaleReceiptRevision");
    expect(mapApprovalReceiptError(stale)._tag).toBe("StaleReceiptRevision");
  });
  it("decodes an SDK problem as its wire body, not as a transport failure", () => {
    expect(nativeFailureFrom(sdkProblem("idempotency.in-flight"))).toEqual(
      makeNativeProblem("idempotency.in-flight"),
    );
    expect(nativeFailureFrom(new TypeError("Network unavailable"))).toBeInstanceOf(TypeError);
  });
  it("preserves canonical validation pointers for existing field messages", () => {
    const endAt = validation("/endAt");
    const amount = validation("/amountOre");
    expect(mapAdmissionPeriodError(Problem.fromWire(endAt, {})).field).toBe("endAt");
    expect(mapOwnedReceiptError(Problem.fromWire(amount, {})).field).toBe("amountNok");
    expect(nativeProblemFrom(Problem.fromWire(validation("/file"), {}))).toEqual(validation("/file"));
  });
  it("reads problems only from the SDK's own value, never from a plain problem-shaped object", () => {
    expect(nativeProblemFrom(validation("/file"))).toBeUndefined();
    expect(nativeProblemFrom({ code: "credential.invalid", status: 401 })).toBeUndefined();
    expect(nativeFailureFrom(makeNativeProblem("credential.invalid"))).toBeUndefined();
  });
});
