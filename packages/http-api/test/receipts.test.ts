import { describe, expect, it } from "vitest";
import {
  InternalReceiptsApi,
  ListReceiptsEndpoint,
  ListReceiptsForApprovalEndpoint,
  ReadReceiptEvidenceEndpoint,
  ReceiptsApi,
  RefundReceiptEndpoint,
  RejectReceiptEndpoint,
  ReviseReceiptEndpoint,
  SubmitReceiptEndpoint,
  WithdrawReceiptEndpoint,
} from "../src/receipts.js";

const outwardPath = (path: string): string =>
  path.replace(/:receiptId(?:\(\[\^:\]\+\))?/u, "{receiptId}").replaceAll("::", ":");

describe("frozen receipt route contract", () => {
  it("projects the suffix-regex declarations to the exact seven public outward routes", () => {
    const routes = [
      [SubmitReceiptEndpoint, "POST", "/api/receipts", "submitReceipt"],
      [ReviseReceiptEndpoint, "PATCH", "/api/receipts/{receiptId}", "reviseReceipt"],
      [
        WithdrawReceiptEndpoint,
        "POST",
        "/api/receipts/{receiptId}:withdraw",
        "withdrawReceipt",
      ],
      [ListReceiptsEndpoint, "GET", "/api/receipts", "listReceipts"],
      [
        ListReceiptsForApprovalEndpoint,
        "GET",
        "/api/receipt-approval-queue",
        "listReceiptsForApproval",
      ],
      [RefundReceiptEndpoint, "POST", "/api/receipts/{receiptId}:refund", "refundReceipt"],
      [RejectReceiptEndpoint, "POST", "/api/receipts/{receiptId}:reject", "rejectReceipt"],
    ] as const;

    expect(routes.map(([endpoint]) => [endpoint.method, outwardPath(endpoint.path)])).toEqual(
      routes.map(([, method, path]) => [method, path]),
    );
    const registrations = routes.map(
      ([endpoint]) => `${endpoint.method} ${outwardPath(endpoint.path)}`,
    );
    expect(new Set(registrations).size).toBe(registrations.length);
    expect(Object.keys(ReceiptsApi.endpoints).sort()).toEqual(
      routes.map(([, , , name]) => name).sort(),
    );
  });

  it("keeps internal.readReceiptEvidence outside the public receipt group", () => {
    expect({
      method: ReadReceiptEvidenceEndpoint.method,
      path: outwardPath(ReadReceiptEvidenceEndpoint.path),
    }).toEqual({
      method: "GET",
      path: "/api/receipt-lifecycle-evidence-records/{receiptId}",
    });
    expect(Object.keys(InternalReceiptsApi.endpoints)).toEqual(["readReceiptEvidence"]);
    expect(Object.keys(ReceiptsApi.endpoints)).not.toContain("readReceiptEvidence");
  });
});
