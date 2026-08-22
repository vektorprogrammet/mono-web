import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../promise.js";

const observation = {
  commandId: "command-1",
  receiptId: "receipt-1",
  visualId: "R-0001",
  status: "Pending",
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
  revision: 1,
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

describe("canonical owner Receipt capability", () => {
  it("submits the exact multipart wire fields and preserves the observation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, observation));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "loopback-token" });
    const file = new File(["receipt"], "receipt.pdf", { type: "application/pdf" });

    const result = await client.receipts.submit(
      {
        commandId: "command-1",
        description: "Train ticket",
        amountOre: 12345,
        receiptDate: "2026-08-20",
      },
      file,
    );

    expect(result).toEqual(observation);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/receipts/submit");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loopback-token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();

    const body = init.body as FormData;
    expect(Array.from(body.keys())).toEqual([
      "commandId",
      "description",
      "amountOre",
      "receiptDate",
      "file",
    ]);
    expect(body.get("commandId")).toBe("command-1");
    expect(body.get("description")).toBe("Train ticket");
    expect(body.get("amountOre")).toBe("12345");
    expect(body.get("receiptDate")).toBe("2026-08-20");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("revises with and without a replacement through the canonical multipart route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, observation))
      .mockResolvedValueOnce(
        response(200, { ...observation, commandId: "command-2", revision: 2 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "loopback-token" });
    const input = {
      commandId: "command-1",
      description: "Updated train ticket",
      amountOre: 13000,
      receiptDate: "2026-08-21",
    };

    await expect(client.receipts.revise("receipt-1", 0, input)).resolves.toEqual(observation);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toBe("http://api.test/api/receipts/receipt-1/revise");
    expect(firstInit.method).toBe("POST");
    expect((firstInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer loopback-token",
    );
    const firstBody = firstInit.body as FormData;
    expect(Array.from(firstBody.keys())).toEqual([
      "commandId",
      "expectedRevision",
      "description",
      "amountOre",
      "receiptDate",
    ]);
    expect(firstBody.get("commandId")).toBe("command-1");
    expect(firstBody.get("expectedRevision")).toBe("0");
    expect(firstBody.get("description")).toBe("Updated train ticket");
    expect(firstBody.get("amountOre")).toBe("13000");
    expect(firstBody.get("receiptDate")).toBe("2026-08-21");

    const replacementFile = new File(["replacement"], "replacement.pdf", {
      type: "application/pdf",
    });
    await expect(
      client.receipts.revise("receipt-1", 1, { ...input, commandId: "command-2" }, replacementFile),
    ).resolves.toMatchObject({ commandId: "command-2", revision: 2 });
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = secondInit.body as FormData;
    expect(Array.from(secondBody.keys())).toEqual([
      "commandId",
      "expectedRevision",
      "description",
      "amountOre",
      "receiptDate",
      "file",
    ]);
    expect(secondBody.get("file")).toMatchObject({
      name: "replacement.pdf",
      type: "application/pdf",
      size: replacementFile.size,
    });
  });

  it("withdraws through the canonical JSON route with the caller command and revision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(200, { ...observation, commandId: "command-3", status: "Withdrawn", revision: 3 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "loopback-token" });

    await expect(client.receipts.withdraw("receipt-1", 2, "command-3")).resolves.toMatchObject({
      commandId: "command-3",
      status: "Withdrawn",
      revision: 3,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/receipts/receipt-1/withdraw");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loopback-token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      commandId: "command-3",
      expectedRevision: 2,
    });
  });

  it("strictly decodes the command observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(200, { ...observation, unexpected: true })),
    );
    const client = createClient("http://api.test");
    const file = new File(["receipt"], "receipt.pdf", { type: "application/pdf" });

    await expect(
      client.receipts.submit(
        {
          commandId: "command-1",
          description: "Train ticket",
          amountOre: 12345,
          receiptDate: "2026-08-20",
        },
        file,
      ),
    ).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "ReceiptDecodeError",
      receiptTag: "ReceiptDecodeError",
    });
  });

  it("lists the strict owner projection and maps typed Receipt rejection tags", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { items: [projection], totalItems: 1 }))
      .mockResolvedValueOnce(
        response(409, {
          error: { tag: "DuplicateReceiptCommandConflict" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", { auth: "loopback-token" });

    await expect(client.receipts.listOwned()).resolves.toEqual({
      items: [projection],
      totalItems: 1,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/receipts");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loopback-token");

    await expect(client.receipts.listOwned()).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: "DuplicateReceiptCommandConflict",
      receiptTag: "DuplicateReceiptCommandConflict",
    });
  });

  it.each([
    ["ReceiptNotFound", 404],
    ["StaleReceiptRevision", 409],
    ["InvalidReceiptTransition", 409],
    ["ReceiptFileNotStaged", 422],
  ] as const)("preserves the native %s rejection", async (tag, status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status, { error: { tag } })));
    const client = createClient("http://api.test", { auth: "loopback-token" });

    await expect(client.receipts.listOwned()).rejects.toMatchObject({
      type: "receipt_rejection",
      _tag: tag,
      receiptTag: tag,
    });
  });
});
