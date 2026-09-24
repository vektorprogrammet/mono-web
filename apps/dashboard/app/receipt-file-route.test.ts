import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeProblemResponse, nativeSessionResponse, routeArgs, sessionCookie } from "../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { loader } from "./routes/dashboard.utlegg.$receiptId.file";

const fileBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const privateFileHeaders = {
  "cache-control": "private, no-store",
  "content-disposition": 'inline; filename="receipt.png"',
  "content-length": String(fileBytes.byteLength),
  "content-type": "image/png",
  vary: "Origin",
  "x-content-type-options": "nosniff",
};

const requests: Request[] = [];

let fileResponse = () => new Response(fileBytes, { headers: privateFileHeaders });

let sessionResponse = nativeSessionResponse;

const load = (receiptId = "receipt-approval-file") => loader(routeArgs(
  new Request(`http://dashboard.test/dashboard/utlegg/${receiptId}/file`, { headers: { cookie: sessionCookie } }),
  { receiptId },
));

const expectPrivateFailure = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBeNull();
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(await response.text()).toBe("");
};

beforeEach(() => {
  requests.length = 0;
  sessionResponse = nativeSessionResponse;
  fileResponse = () => new Response(fileBytes, { headers: privateFileHeaders });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);

    return new URL(request.url).pathname === "/api/session" ? sessionResponse() : fileResponse();
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("receipt approval file resource route", () => {
  it("forwards the session and exact private bytes through the same-origin route", async () => {
    const response = await load();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes);
    expect(Object.fromEntries(response.headers)).toEqual(privateFileHeaders);
    const upstream = requests.find(request => new URL(request.url).pathname.endsWith("/file"));
    expect(upstream?.headers.get("cookie")).toBe(sessionCookie);
  });
  it("denies an expired session before fetching private bytes", async () => {
    sessionResponse = () => nativeProblemResponse("credential.invalid");
    await expectPrivateFailure(await load(), 401);
    expect(requests.some(request => new URL(request.url).pathname.endsWith("/file"))).toBe(false);
  });
  it("conceals invalid receipt paths without a file request", async () => {
    await expectPrivateFailure(await load(""), 404);
    expect(requests.some(request => new URL(request.url).pathname.endsWith("/file"))).toBe(false);
  });
  it.each([
    ["credential.invalid", 401], ["authority.denied", 403], ["origin.denied", 403],
    ["resource.not-found", 404], ["receipts.unavailable", 503],
  ] as const)("maps %s without exposing its problem body", async (code, status) => {
    fileResponse = () => nativeProblemResponse(code);
    await expectPrivateFailure(await load(), status);
  });
  it("conceals malformed upstream problem bodies", async () => {
    fileResponse = () => Response.json({ code: "credential.invalid", secret: "private-detail" }, { status: 401 });
    await expectPrivateFailure(await load(), 503);
  });
  it.each([["image/jpeg", "jpg"], ["application/pdf", "pdf"]] as const)("preserves %s media metadata", async (contentType, extension) => {
    fileResponse = () => new Response(fileBytes, { headers: {
      ...privateFileHeaders, "content-disposition": `inline; filename="receipt.${extension}"`, "content-type": contentType,
    } });
    const response = await load();
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("content-disposition")).toBe(`inline; filename="receipt.${extension}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes);
  });
  it("withholds bytes when upstream headers violate the private-file contract", async () => {
    fileResponse = () => new Response(fileBytes, { headers: { ...privateFileHeaders, "content-disposition": "attachment; filename=receipt.png" } });
    await expectPrivateFailure(await load(), 503);
  });
  it("rejects an empty body even with a matching zero length", async () => {
    fileResponse = () => new Response(null, { headers: { ...privateFileHeaders, "content-length": "0" } });
    await expectPrivateFailure(await load(), 503);
  });
});
