import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { ReceiptsApi } from "../src/receipts.js";

const ReceiptContractApi = HttpApi.make("receipt-contract").add(ReceiptsApi);

describe("frozen receipt route contract", () => {
  it("publishes the thirteen outward receipt operations without internal evidence routes", () => {
    const document = OpenApi.fromApi(ReceiptContractApi);

    const operations = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(operations.sort()).toEqual(
      [
        "GET /api/receipts/{receiptId}/file",
        "GET /api/receipt-approval-queue/{receiptId}/file",
        "POST /api/receipts",
        "PATCH /api/receipts/{receiptId}",
        "POST /api/receipts/{receiptId}:withdraw",
        "GET /api/receipts",
        "GET /api/receipt-approval-queue",
        "POST /api/receipts/{receiptId}:approve",
        "POST /api/receipts/{receiptId}:reject",
        "POST /api/receipts/{receiptId}:reopen",
        "GET /api/receipt-settlement-queue",
        "GET /api/receipt-settlement-queue/{receiptId}",
        "POST /api/receipts/{receiptId}:settle",
      ].sort(),
    );
  });
});
