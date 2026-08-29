import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmbiguousParameterFillError,
  createClient,
  FailedComposedRequirementError,
  ReceiptRejectionError,
  ReceiptDecodeSdkError,
  ReceiptScopeDeniedError,
  UnauthorizedError,
} from "../promise.js";

const observation = {
  commandId: "command-refund",
  receiptId: "receipt-1",
  visualId: "R-0001",
  status: "Refunded",
  revision: 1,
  replayed: false,
};

const projection = {
  receiptId: "receipt-1",
  visualId: "R-0001",
  ownerPersonId: "person-1",
  departmentId: "department-1",
  amountOre: 12345,
  currency: "NOK",
  description: "Train ticket",
  receiptDate: "2026-08-20",
  status: "Pending",
  revision: 0,
};

const response = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical Receipt approval capability", () => {
  it("lists the strict approval projection with only the canonical status filter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(200, { items: [projection], totalItems: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    await expect(client.receipts.listForApproval({ status: "Pending" })).resolves.toEqual({
      items: [projection],
      totalItems: 1,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/admin/receipts?status=Pending");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Accept).toBe("application/ld+json");
    expect((init.headers as Record<string, string>).Cookie).toBe(
      "better-auth.session_token=approver-session",
    );
  });

  it("maps canonical 403 ReceiptScopeDenied to a typed public error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(403, { error: { tag: "ReceiptScopeDenied" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    const error = await client.receipts
      .listForApproval({ status: "Pending" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReceiptScopeDeniedError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({
      type: "receipt_rejection",
      _tag: "ReceiptScopeDenied",
      receiptTag: "ReceiptScopeDenied",
    });
  });

  it.each([
    ["ReceiptAuthorityDenied", "Receipt command is not permitted"],
    ["AmbiguousPaymentSelection", "Payment authority selection is ambiguous"],
  ] as const)("maps canonical 403 %s without exposing authority facts", async (tag, message) => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(403, {
        error: {
          tag,
          message,
          personId: "person-sensitive",
          operation: "GlobalApproval",
          departmentId: "department-sensitive",
          departmentIds: ["department-sensitive"],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    const error = await client.receipts
      .listForApproval({ status: "Pending" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReceiptRejectionError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect(error).toMatchObject({
      type: "receipt_rejection",
      _tag: tag,
      receiptTag: tag,
      status: 403,
      message,
    });
    expect(error).not.toHaveProperty("personId");
    expect(error).not.toHaveProperty("operation");
    expect(error).not.toHaveProperty("departmentId");
    expect(error).not.toHaveProperty("departmentIds");
  });
  it.each([
    [
      "AmbiguousParameterFill",
      "Authorization parameter fill is ambiguous",
      AmbiguousParameterFillError,
    ],
    [
      "FailedComposedRequirement",
      "Composed authorization requirement failed",
      FailedComposedRequirementError,
    ],
  ] as const)(
    "strictly maps canonical composed denial %s on the Promise surface",
    async (tag, message, ErrorClass) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(403, { error: { tag, message } })));
      const error = await createClient("http://api.test", {
        cookie: "better-auth.session_token=approver-session",
      })
        .receipts.listForApproval()
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toMatchObject({
        type: "receipt_rejection",
        _tag: tag,
        receiptTag: tag,
        status: 403,
        message,
      });
    },
  );

  it("rejects malformed composed denials on the Promise surface", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(403, {
          error: {
            tag: "AmbiguousParameterFill",
            message: "backend-controlled replacement",
          },
        }),
      )
      .mockResolvedValueOnce(
        response(403, {
          error: {
            tag: "FailedComposedRequirement",
            message: "Composed authorization requirement failed",
            personId: "person-sensitive",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await client.receipts.listForApproval().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReceiptDecodeSdkError);
    }
  });

  it("keeps an unknown tagged 403 response as UnauthorizedError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(403, {
        error: {
          tag: "UnknownReceiptAuthorityDenial",
          message: "Untrusted backend detail",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    const error = await client.receipts
      .listForApproval({ status: "Pending" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).not.toBeInstanceOf(ReceiptRejectionError);
    expect(error).toMatchObject({ type: "unauthorized", message: "HTTP 403" });
  });

  it("rejects authority fields in approval filters before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    await expect(
      client.receipts.listForApproval({ departmentId: "department-1" } as never),
    ).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "ReceiptDecodeError",
      receiptTag: "ReceiptDecodeError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refunds through the semantic JSON route with the exact resolution body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, observation));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    await expect(client.receipts.refund("receipt-1", 0, "command-refund")).resolves.toEqual(
      observation,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/admin/receipts/receipt-1/refund");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Cookie).toBe(
      "better-auth.session_token=approver-session",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      commandId: "command-refund",
      expectedRevision: 0,
    });
  });

  it("rejects through the semantic JSON route and strictly decodes observations", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, { ...observation, commandId: "command-reject", status: "Rejected" }),
      )
      .mockResolvedValueOnce(response(200, { ...observation, unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=approver-session",
    });

    await expect(client.receipts.reject("receipt-1", 0, "command-reject")).resolves.toMatchObject({
      commandId: "command-reject",
      status: "Rejected",
      revision: 1,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/admin/receipts/receipt-1/reject");
    expect(JSON.parse(String(init.body))).toEqual({
      commandId: "command-reject",
      expectedRevision: 0,
    });

    await expect(client.receipts.reject("receipt-1", 0, "command-reject")).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "ReceiptDecodeError",
      receiptTag: "ReceiptDecodeError",
    });
  });
});
