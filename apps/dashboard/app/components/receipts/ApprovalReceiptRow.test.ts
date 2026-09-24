import { createElement } from "react";
import { StrongETag } from "@vektorprogrammet/http-api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalReceiptView } from "../../lib/receipt-view";
import { ApprovalReceiptRow } from "./ApprovalReceiptRow";

const terminalReceipt = {
  amount: "125,50 NOK",
  amountOre: 12_550,
  currency: "NOK" as const,
  departmentId: "department-a",
  description: "Terminal receipt file remains readable",
  ownerPersonId: "person-owner",
  etag: StrongETag.make('"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'),
  receiptDate: "2026-09-20",
  receiptId: "receipt/id with a space",
  revision: 1,
  approvedAt: "2026-09-20T12:00:00.000Z",
  status: "Approved" as const,
  visualId: "KV-1001",
} satisfies ApprovalReceiptView;

describe("approval receipt file link", () => {
  it("keeps an accessible new-tab receipt link for terminal approval rows", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "table",
        null,
        createElement(
          "tbody",
          null,
          createElement(ApprovalReceiptRow, {
            receipt: terminalReceipt,
            actionErrorId: "approval-error",
          }),
        ),
      ),
    );

    expect(markup).toContain('href="/dashboard/utlegg/receipt%2Fid%20with%20a%20space/file"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(">Vis kvittering</a>");
    expect(markup).toContain('data-terminal="true"');
  });
});
