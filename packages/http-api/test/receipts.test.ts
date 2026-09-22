import { describe, expect, it } from "vitest";
import {
  ApproveReceiptEndpoint,
  InternalReceiptsApi,
  ListReceiptsEndpoint,
  ListReceiptsForApprovalEndpoint,
  ListReceiptsForSettlementEndpoint,
  ReadReceiptEvidenceEndpoint,
  ReadReceiptFileEndpoint,
  ReadReceiptFileForApprovalEndpoint,
  ReadReceiptSettlementForFinanceEndpoint,
  ReceiptsApi,
  RejectReceiptEndpoint,
  ReopenReceiptEndpoint,
  ReviseReceiptEndpoint,
  SettleReceiptEndpoint,
  SubmitReceiptEndpoint,
  WithdrawReceiptEndpoint,
} from "../src/receipts.js";

const outwardPath = (path: string): string =>
  path.replace(/:receiptId(?:\(\[\^:\]\+\))?/u, "{receiptId}").replaceAll("::", ":");

describe("frozen receipt route contract", () => {
  it("projects the suffix-regex declarations to the exact thirteen public outward routes", () => {
    const routes = [
      [ReadReceiptFileEndpoint, "GET", "/api/receipts/{receiptId}/file", "readReceiptFile"],
      [
        ReadReceiptFileForApprovalEndpoint,
        "GET",
        "/api/receipt-approval-queue/{receiptId}/file",
        "readReceiptFileForApproval",
      ],
      [SubmitReceiptEndpoint, "POST", "/api/receipts", "submitReceipt"],
      [ReviseReceiptEndpoint, "PATCH", "/api/receipts/{receiptId}", "reviseReceipt"],
      [WithdrawReceiptEndpoint, "POST", "/api/receipts/{receiptId}:withdraw", "withdrawReceipt"],
      [ListReceiptsEndpoint, "GET", "/api/receipts", "listReceipts"],
      [
        ListReceiptsForApprovalEndpoint,
        "GET",
        "/api/receipt-approval-queue",
        "listReceiptsForApproval",
      ],
      [ApproveReceiptEndpoint, "POST", "/api/receipts/{receiptId}:approve", "approveReceipt"],
      [RejectReceiptEndpoint, "POST", "/api/receipts/{receiptId}:reject", "rejectReceipt"],
      [ReopenReceiptEndpoint, "POST", "/api/receipts/{receiptId}:reopen", "reopenReceipt"],
      [
        ListReceiptsForSettlementEndpoint,
        "GET",
        "/api/receipt-settlement-queue",
        "listReceiptsForSettlement",
      ],
      [
        ReadReceiptSettlementForFinanceEndpoint,
        "GET",
        "/api/receipt-settlement-queue/{receiptId}",
        "readReceiptSettlementForFinance",
      ],
      [SettleReceiptEndpoint, "POST", "/api/receipts/{receiptId}:settle", "settleReceipt"],
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
