import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAuthenticatedClient: vi.fn(),
  nativeProblemFrom: vi.fn(),
  readReceiptFileForApproval: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("./lib/api.server", () => ({
  createAuthenticatedClient: mocks.createAuthenticatedClient,
}));
vi.mock("./lib/auth.server", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("./lib/native-problem", () => ({ nativeProblemFrom: mocks.nativeProblemFrom }));

import { loader } from "./routes/dashboard.utlegg.$receiptId.file";

const fileBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const privateFileHeaders = {
  "cache-control": "private, no-store",
  "content-disposition": 'inline; filename="receipt.png"',
  "content-length": String(fileBytes.byteLength),
  "content-type": "image/png",
  vary: "Origin",
  "x-content-type-options": "nosniff",
} as const;

const load = (receiptId = "receipt-approval-file") =>
  loader({
    params: { receiptId },
    request: new Request(`http://dashboard.test/dashboard/utlegg/${receiptId}/file`),
  } as never);

const expectPrivateFailure = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBeNull();
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(await response.text()).toBe("");
};

describe("receipt approval file resource route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("better-auth.session_token=approval-session");
    mocks.createAuthenticatedClient.mockReturnValue({
      receipts: { readReceiptFileForApproval: mocks.readReceiptFileForApproval },
    });
    mocks.readReceiptFileForApproval.mockResolvedValue({
      body: fileBytes,
      headers: privateFileHeaders,
    });
  });

  it("forwards the current session and exact approved bytes through the same-origin route", async () => {
    const response = await load();

    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(fileBytes));
    expect(Object.fromEntries(response.headers.entries())).toEqual(privateFileHeaders);
    expect(mocks.createAuthenticatedClient).toHaveBeenCalledWith(
      "better-auth.session_token=approval-session",
      expect.any(Request),
    );
    expect(mocks.readReceiptFileForApproval).toHaveBeenCalledWith({
      params: { receiptId: "receipt-approval-file" },
    });
  });

  it.each([302, 401])(
    "does not construct an SDK client when authentication responds with %i",
    async (status) => {
      mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status }));

      await expectPrivateFailure(await load(), 401);

      expect(mocks.createAuthenticatedClient).not.toHaveBeenCalled();
      expect(mocks.readReceiptFileForApproval).not.toHaveBeenCalled();
    },
  );

  it("conceals invalid receipt paths without invoking the approval file operation", async () => {
    await expectPrivateFailure(await load(""), 404);

    expect(mocks.readReceiptFileForApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["credential", "credential.invalid", 401],
    ["scope", "authority.denied", 403],
    ["origin", "origin.denied", 403],
    ["absence", "resource.not-found", 404],
    ["unavailable", "receipts.unavailable", 503],
    ["unknown", undefined, 503],
  ] as const)(
    "maps a %s upstream failure without its problem body",
    async (_name, code, status) => {
      mocks.readReceiptFileForApproval.mockRejectedValueOnce({ opaque: "private-upstream-detail" });
      mocks.nativeProblemFrom.mockReturnValueOnce(code === undefined ? undefined : { code });

      await expectPrivateFailure(await load(), status);
    },
  );

  it.each([
    ["JPEG", "image/jpeg", "jpg"],
    ["PDF", "application/pdf", "pdf"],
  ] as const)(
    "preserves the canonical %s file media contract",
    async (_name, contentType, extension) => {
      const headers = {
        ...privateFileHeaders,
        "content-disposition": `inline; filename="receipt.${extension}"`,
        "content-type": contentType,
      };
      mocks.readReceiptFileForApproval.mockResolvedValueOnce({ body: fileBytes, headers });

      const response = await load();

      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-disposition")).toBe(
        `inline; filename="receipt.${extension}"`,
      );
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
        Array.from(fileBytes),
      );
    },
  );

  it("withholds bytes when the upstream file headers cannot establish the private contract", async () => {
    mocks.readReceiptFileForApproval.mockResolvedValueOnce({
      body: fileBytes,
      headers: { ...privateFileHeaders, "content-disposition": "attachment; filename=receipt.png" },
    });

    await expectPrivateFailure(await load(), 503);
  });

  it("rejects an empty body even when upstream reports a matching zero length", async () => {
    mocks.readReceiptFileForApproval.mockResolvedValueOnce({
      body: new Uint8Array(),
      headers: { ...privateFileHeaders, "content-length": "0" },
    });

    await expectPrivateFailure(await load(), 503);
  });
});
