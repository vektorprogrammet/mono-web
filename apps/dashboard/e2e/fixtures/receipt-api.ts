type BunReceiptServer = { stop(force?: boolean): void };
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch(request: Request): Response | Promise<Response>;
  }): BunReceiptServer;
};

type ReceiptStatus = "Pending" | "Refunded" | "Rejected" | "Withdrawn";
type Operation =
  | "profile"
  | "personal-list"
  | "personal-create"
  | "personal-update"
  | "personal-delete"
  | "admin-list"
  | "admin-status";
type MalformedMode = "receipt-date" | "admin-shape" | "create-response";

type ReceiptWire = {
  receiptId: string;
  visualId: string;
  ownerPersonId: string;
  departmentId: string;
  amountOre: number;
  currency: "NOK";
  description: string;
  receiptDate: string;
  submittedAt: string;
  status: ReceiptStatus;
  refundDate: string | null;
  revision: number;
  etag: string;
};

type Fault = {
  status?: number;
  malformed?: MalformedMode;
};

type BodyShape =
  | { kind: "empty" }
  | { kind: "json"; keys: string[] }
  | { kind: "multipart"; fields: string[]; filePresent: boolean };

type Evidence = {
  method: string;
  path: string;
  query: Record<string, string>;
  selectedHeaders: {
    authorization: "bearer" | "missing";
    contentType: string | null;
    idempotencyKey: string | null;
    ifMatch: string | null;
  };
  bodyShape: BodyShape;
  status: number;
};

const operations: Record<Operation, true> = {
  profile: true,
  "personal-list": true,
  "personal-create": true,
  "personal-update": true,
  "personal-delete": true,
  "admin-list": true,
  "admin-status": true,
};
const malformedModes: Record<MalformedMode, true> = {
  "receipt-date": true,
  "admin-shape": true,
  "create-response": true,
};

const etagFor = (receiptId: string, revision: number): string => {
  const bytes = new TextEncoder().encode(`${receiptId}:${revision}`);
  let encoded = "";
  for (let index = 0; index < 32; index += 1) {
    encoded += String.fromCharCode(bytes[index % bytes.length] ?? index);
  }
  return `"vkr2.${btoa(encoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}"`;
};

const makeReceipt = (
  receiptId: string,
  description: string,
  amountOre: number,
  receiptDate: string,
  status: ReceiptStatus = "Pending",
): ReceiptWire => ({
  receiptId,
  visualId: receiptId,
  ownerPersonId: receiptId.startsWith("admin") ? `owner-${receiptId}` : "7",
  departmentId: "department-trondheim",
  amountOre,
  currency: "NOK",
  description,
  receiptDate,
  submittedAt: "2026-08-09T00:00:00.000Z",
  status,
  refundDate: status === "Refunded" ? "2026-08-10T00:00:00.000Z" : null,
  revision: status === "Pending" ? 0 : 1,
  etag: etagFor(receiptId, status === "Pending" ? 0 : 1),
});

let personalReceipts: ReceiptWire[] = [];
let adminReceipts: ReceiptWire[] = [];
let faults = new Map<Operation, Fault>();
let evidence: Evidence[] = [];
let transitions: string[] = [];
const replayedResponses = new Map<string, ReceiptWire>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOperation(value: string): value is Operation {
  return value in operations;
}

function isMalformedMode(value: string): value is MalformedMode {
  return value in malformedModes;
}

function resetState(): void {
  personalReceipts = [makeReceipt("personal-1", "Course travel", 7_500, "2026-08-08")];
  adminReceipts = [
    makeReceipt("admin-10", "Approval receipt", 15_000, "2026-08-05"),
    makeReceipt("admin-11", "Rejection receipt", 20_000, "2026-08-06"),
    makeReceipt("admin-12", "Withdrawn receipt", 22_500, "2026-08-07", "Withdrawn"),
    makeReceipt("admin-13", "Already refunded", 30_000, "2026-08-04", "Refunded"),
  ];
  faults = new Map();
  evidence = [];
  transitions = [];
  replayedResponses.clear();
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function resourceResponse(body: ReceiptWire, status = 200): Response {
  return jsonResponse(body, status, {
    etag: body.etag,
    "cache-control": "private, no-cache",
    vary: "Cookie, Authorization",
    ...(status === 201 ? { location: `/api/receipts/${encodeURIComponent(body.receiptId)}` } : {}),
  });
}

function noContent(status = 204): Response {
  return new Response(null, { status });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `urn:vektorprogrammet:problem:v0.2:${code}`,
      title: detail,
      status,
      code,
      detail,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function queryValues(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

function authKind(request: Request): "bearer" | "missing" {
  return request.headers.get("authorization")?.startsWith("Bearer ") ? "bearer" : "missing";
}

function record(request: Request, url: URL, bodyShape: BodyShape, status: number): void {
  evidence.push({
    method: request.method,
    path: url.pathname,
    query: queryValues(url),
    selectedHeaders: {
      authorization: authKind(request),
      contentType: request.headers.get("content-type"),
      idempotencyKey: request.headers.get("idempotency-key"),
      ifMatch: request.headers.get("if-match"),
    },
    bodyShape,
    status,
  });
}

function unauthorized(request: Request, url: URL): Response | null {
  if (authKind(request) === "bearer") return null;
  record(request, url, { kind: "empty" }, 401);
  return problem(401, "credential.missing", "A credential is required.");
}

function malformedBody(operation: Operation, mode: MalformedMode): unknown {
  if (operation === "personal-list" && mode === "receipt-date") {
    return { items: [{ ...makeReceipt("malformed", "Malformed receipt", 2_000, "not-a-date") }], totalItems: 1 };
  }
  if (operation === "admin-list" && mode === "admin-shape") {
    return { items: [{ receiptId: "malformed-admin" }], totalItems: 1 };
  }
  return { receiptId: 99 };
}

function faultResponse(operation: Operation, request: Request, url: URL): Response | null {
  const fault = faults.get(operation);
  if (fault === undefined) return null;
  const status = fault.status ?? 200;
  const body = fault.malformed
    ? malformedBody(operation, fault.malformed)
    : {
        type: "urn:vektorprogrammet:problem:v0.2:dependency.unavailable",
        title: "Synthetic dependency failure",
        status,
        code: "dependency.unavailable",
        detail: "Synthetic dependency failure",
      };
  record(request, url, { kind: "json", keys: isRecord(body) ? Object.keys(body).sort() : [] }, status);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

async function parseMultipart(request: Request): Promise<{
  form: FormData | null;
  bodyShape: Extract<BodyShape, { kind: "multipart" }>;
}> {
  try {
    const form = await request.formData();
    const fields: string[] = [];
    let filePresent = false;
    for (const [name, value] of form.entries()) {
      fields.push(name);
      if (name === "file" && value instanceof File && value.size > 0) filePresent = true;
    }
    return { form, bodyShape: { kind: "multipart", fields: fields.sort(), filePresent } };
  } catch {
    return { form: null, bodyShape: { kind: "multipart", fields: [], filePresent: false } };
  }
}

function requireMutationHeaders(request: Request, url: URL): Response | null {
  if (request.headers.get("idempotency-key") === null) {
    record(request, url, { kind: "empty" }, 400);
    return problem(400, "idempotency-key.invalid", "Idempotency-Key is required.");
  }
  if (request.headers.get("if-match") === null) {
    record(request, url, { kind: "empty" }, 428);
    return problem(428, "precondition.required", "If-Match is required.");
  }
  return null;
}

function assertIfMatch(request: Request, url: URL, receipt: ReceiptWire): Response | null {
  if (request.headers.get("if-match") === receipt.etag) return null;
  record(request, url, { kind: "empty" }, 412);
  return problem(412, "precondition.failed", "The Receipt representation changed.");
}

function replay(request: Request): ReceiptWire | undefined {
  const idempotencyKey = request.headers.get("idempotency-key");
  return idempotencyKey === null ? undefined : replayedResponses.get(idempotencyKey);
}

function remember(request: Request, receipt: ReceiptWire): void {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null) replayedResponses.set(idempotencyKey, structuredClone(receipt));
}

async function handleProfile(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("profile", request, url);
  if (fault !== null) return fault;
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({
    personId: "7",
    firstName: "Trace",
    lastName: "User",
    email: "trace@example.test",
    phone: "",
    role: "ROLE_TEAM_MEMBER",
    nameRevision: 0,
    contactRevision: 0,
  });
}

async function handlePersonalList(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-list", request, url);
  if (fault !== null) return fault;
  const status = url.searchParams.get("status");
  const rows = status === null ? personalReceipts : personalReceipts.filter((item) => item.status === status);
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({ items: rows, totalItems: rows.length });
}

async function handlePersonalCreate(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-create", request, url);
  if (fault !== null) return fault;
  if (request.headers.get("idempotency-key") === null) {
    record(request, url, { kind: "empty" }, 400);
    return problem(400, "idempotency-key.invalid", "Idempotency-Key is required.");
  }
  const replayed = replay(request);
  if (replayed !== undefined) return resourceResponse(replayed, 201);
  const parsed = await parseMultipart(request);
  const description = parsed.form?.get("description");
  const amountOre = parsed.form?.get("amountOre");
  const receiptDate = parsed.form?.get("receiptDate");
  const numericAmountOre = typeof amountOre === "string" ? Number(amountOre) : Number.NaN;
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    !Number.isSafeInteger(numericAmountOre) ||
    numericAmountOre <= 0 ||
    typeof receiptDate !== "string" ||
    !parsed.bodyShape.filePresent
  ) {
    record(request, url, parsed.bodyShape, 422);
    return problem(422, "validation.failed", "The Receipt input is invalid.");
  }
  const receipt = makeReceipt("personal-99", description, numericAmountOre, receiptDate);
  personalReceipts = personalReceipts.filter((item) => item.receiptId !== receipt.receiptId);
  personalReceipts.push(receipt);
  remember(request, receipt);
  transitions.push(`personal:create:${receipt.receiptId}`);
  record(request, url, parsed.bodyShape, 201);
  return resourceResponse(receipt, 201);
}

async function handlePersonalUpdate(request: Request, url: URL, receiptId: string): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-update", request, url);
  if (fault !== null) return fault;
  const headerFailure = requireMutationHeaders(request, url);
  if (headerFailure !== null) return headerFailure;
  const replayed = replay(request);
  if (replayed !== undefined) return resourceResponse(replayed);
  const receipt = personalReceipts.find((item) => item.receiptId === receiptId);
  if (receipt === undefined) return problem(404, "receipt.not-found", "The Receipt does not exist.");
  const preconditionFailure = assertIfMatch(request, url, receipt);
  if (preconditionFailure !== null) return preconditionFailure;
  const parsed = await parseMultipart(request);
  if (parsed.form === null) return problem(422, "validation.failed", "The Receipt input is invalid.");
  const description = parsed.form.get("description");
  const amountOre = parsed.form.get("amountOre");
  const receiptDate = parsed.form.get("receiptDate");
  if (typeof description === "string") receipt.description = description;
  if (typeof amountOre === "string" && Number.isSafeInteger(Number(amountOre))) receipt.amountOre = Number(amountOre);
  if (typeof receiptDate === "string") receipt.receiptDate = receiptDate;
  receipt.revision += 1;
  receipt.etag = etagFor(receipt.receiptId, receipt.revision);
  remember(request, receipt);
  transitions.push(`personal:update:${receiptId}`);
  record(request, url, parsed.bodyShape, 200);
  return resourceResponse(receipt);
}

async function handlePersonalWithdraw(request: Request, url: URL, receiptId: string): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-delete", request, url);
  if (fault !== null) return fault;
  const headerFailure = requireMutationHeaders(request, url);
  if (headerFailure !== null) return headerFailure;
  const replayed = replay(request);
  if (replayed !== undefined) return resourceResponse(replayed);
  const receipt = personalReceipts.find((item) => item.receiptId === receiptId);
  if (receipt === undefined) return problem(404, "receipt.not-found", "The Receipt does not exist.");
  const preconditionFailure = assertIfMatch(request, url, receipt);
  if (preconditionFailure !== null) return preconditionFailure;
  if (receipt.status !== "Pending") return problem(409, "receipt.invalid-transition", "The Receipt cannot be withdrawn.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "request.malformed", "The request is malformed.");
  }
  if (!isRecord(body) || Object.keys(body).length !== 0) return problem(422, "validation.failed", "The request body must be empty.");
  receipt.status = "Withdrawn";
  receipt.revision += 1;
  receipt.etag = etagFor(receipt.receiptId, receipt.revision);
  remember(request, receipt);
  transitions.push(`personal:withdraw:${receiptId}`);
  record(request, url, { kind: "json", keys: [] }, 200);
  return resourceResponse(receipt);
}

async function handleAdminList(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("admin-list", request, url);
  if (fault !== null) return fault;
  const status = url.searchParams.get("status");
  const rows = status === null ? adminReceipts : adminReceipts.filter((item) => item.status === status);
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({ items: rows, totalItems: rows.length });
}

async function handleAdminStatus(
  request: Request,
  url: URL,
  receiptId: string,
  status: "Refunded" | "Rejected",
): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("admin-status", request, url);
  if (fault !== null) return fault;
  const headerFailure = requireMutationHeaders(request, url);
  if (headerFailure !== null) return headerFailure;
  const replayed = replay(request);
  if (replayed !== undefined) return resourceResponse(replayed);
  const receipt = adminReceipts.find((item) => item.receiptId === receiptId);
  if (receipt === undefined) return problem(404, "receipt.not-found", "The Receipt does not exist.");
  const preconditionFailure = assertIfMatch(request, url, receipt);
  if (preconditionFailure !== null) return preconditionFailure;
  if (receipt.status !== "Pending") return problem(409, "receipt.invalid-transition", "The Receipt cannot change status.");
  receipt.status = status;
  receipt.refundDate = status === "Refunded" ? "2026-08-10T00:00:00.000Z" : null;
  receipt.revision += 1;
  receipt.etag = etagFor(receipt.receiptId, receipt.revision);
  remember(request, receipt);
  transitions.push(`admin:${receiptId}:${status}`);
  record(request, url, { kind: "json", keys: [] }, 200);
  return resourceResponse(receipt);
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/profile" && request.method === "GET") return handleProfile(request, url);
  if (url.pathname === "/api/receipts" && request.method === "GET") return handlePersonalList(request, url);
  if (url.pathname === "/api/receipts" && request.method === "POST") return handlePersonalCreate(request, url);
  if (url.pathname === "/api/receipt-approval-queue" && request.method === "GET") return handleAdminList(request, url);

  const reviseMatch = url.pathname.match(/^\/api\/receipts\/([^/:]+)$/u);
  if (reviseMatch !== null && request.method === "PATCH") {
    return handlePersonalUpdate(request, url, decodeURIComponent(reviseMatch[1]));
  }
  const actionMatch = url.pathname.match(/^\/api\/receipts\/([^/:]+):(withdraw|refund|reject)$/u);
  if (actionMatch !== null && request.method === "POST") {
    const receiptId = decodeURIComponent(actionMatch[1]);
    if (actionMatch[2] === "withdraw") return handlePersonalWithdraw(request, url, receiptId);
    return handleAdminStatus(request, url, receiptId, actionMatch[2] === "refund" ? "Refunded" : "Rejected");
  }
  return problem(404, "route.not-found", "The requested route does not exist.");
}

async function control(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noContent(400);
  }
  if (!isRecord(body) || typeof body.operation !== "string" || !isOperation(body.operation)) return noContent(400);
  if (body.action === "clear") {
    faults.delete(body.operation);
    return noContent();
  }
  const fault: Fault = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "number" || !Number.isInteger(body.status) || body.status < 400 || body.status > 599) return noContent(400);
    fault.status = body.status;
  }
  if (body.malformed !== undefined) {
    if (typeof body.malformed !== "string" || !isMalformedMode(body.malformed)) return noContent(400);
    fault.malformed = body.malformed;
  }
  if (fault.status === undefined && fault.malformed === undefined) return noContent(400);
  faults.set(body.operation, fault);
  return noContent();
}

resetState();
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : "8787");
if (!Number.isInteger(port) || port <= 0) throw new Error("receipt stub requires --port 8787");

let shuttingDown = false;
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__health") return jsonResponse({ ok: true });
    if (url.pathname === "/__control/reset" && request.method === "POST") {
      resetState();
      return noContent();
    }
    if (url.pathname === "/__control/fault" && request.method === "POST") return control(request);
    if (url.pathname === "/__control/evidence" && request.method === "GET") {
      return jsonResponse({ evidence, transitions, personalReceipts, adminReceipts });
    }
    return handleApi(request, url);
  },
});

const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop(true);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
console.log(`receipt stub ready on http://127.0.0.1:${port}`);
