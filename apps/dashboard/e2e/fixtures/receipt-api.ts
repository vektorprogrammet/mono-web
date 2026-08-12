type BunReceiptServer = {
  hostname: string;
  port: number;
  stop(): Promise<void>;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunReceiptServer;
};
type ReceiptStatus = "pending" | "refunded" | "rejected";
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
  id: number;
  visualId: string;
  description: string;
  sum: number;
  receiptDate: string;
  submitDate: string;
  status: ReceiptStatus;
  refundDate: string | null;
};

type AdminReceiptWire = {
  id: number;
  visualId: string;
  description: string;
  sum: number;
  receiptDate: string;
  submitDate: string;
  status: ReceiptStatus;
  refundDate: string | null;
  userName: string;
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

let personalReceipts: ReceiptWire[] = [];
let adminReceipts: AdminReceiptWire[] = [];
let faults = new Map<Operation, Fault>();
let evidence: Evidence[] = [];
let transitions: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOperation(value: string): value is Operation {
  return value in operations;
}

function isMalformedMode(value: string): value is MalformedMode {
  return value in malformedModes;
}

function resetState() {
  personalReceipts = [
    {
      id: 1,
      visualId: "personal-1",
      description: "Course travel",
      sum: 75,
      receiptDate: "2026-08-08T00:00:00.000Z",
      submitDate: "2026-08-09T00:00:00.000Z",
      status: "pending",
      refundDate: null,
    },
  ];
  adminReceipts = [
    {
      id: 10,
      visualId: "admin-10",
      description: "Approval receipt",
      sum: 150,
      receiptDate: "2026-08-05T00:00:00.000Z",
      submitDate: "2026-08-06T00:00:00.000Z",
      status: "pending",
      refundDate: null,
      userName: "Kari Nordmann",
    },
    {
      id: 11,
      visualId: "admin-11",
      description: "Rejection receipt",
      sum: 200,
      receiptDate: "2026-08-06T00:00:00.000Z",
      submitDate: "2026-08-07T00:00:00.000Z",
      status: "pending",
      refundDate: null,
      userName: "Ola Hansen",
    },
    {
      id: 12,
      visualId: "admin-12",
      description: "Reopen receipt",
      sum: 225,
      receiptDate: "2026-08-07T00:00:00.000Z",
      submitDate: "2026-08-08T00:00:00.000Z",
      status: "rejected",
      refundDate: null,
      userName: "Lise Berg",
    },
    {
      id: 13,
      visualId: "admin-13",
      description: "Already refunded",
      sum: 300,
      receiptDate: "2026-08-04T00:00:00.000Z",
      submitDate: "2026-08-05T00:00:00.000Z",
      status: "refunded",
      refundDate: "2026-08-09T00:00:00.000Z",
      userName: "Per Hansen",
    },
  ];
  faults = new Map();
  evidence = [];
  transitions = [];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContent(status = 204): Response {
  return new Response(null, { status });
}

function queryValues(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

function authKind(request: Request): "bearer" | "missing" {
  return request.headers.get("authorization")?.startsWith("Bearer ")
    ? "bearer"
    : "missing";
}

function record(
  request: Request,
  url: URL,
  bodyShape: BodyShape,
  status: number,
): void {
  evidence.push({
    method: request.method,
    path: url.pathname,
    query: queryValues(url),
    selectedHeaders: {
      authorization: authKind(request),
      contentType: request.headers.get("content-type"),
    },
    bodyShape,
    status,
  });
}

function unauthorized(request: Request, url: URL): Response | null {
  if (authKind(request) === "bearer") return null;
  record(request, url, { kind: "empty" }, 401);
  return jsonResponse({ error: "unauthorized" }, 401);
}

function malformedBody(operation: Operation, mode: MalformedMode): unknown {
  if (operation === "personal-list" && mode === "receipt-date") {
    return {
      "hydra:member": [
        {
          id: 1,
          visualId: "malformed",
          description: "Malformed receipt",
          sum: 20,
          receiptDate: "not-a-date",
          submitDate: "2026-08-09T00:00:00.000Z",
          status: "pending",
          refundDate: null,
        },
      ],
      "hydra:totalItems": 1,
    };
  }

  if (operation === "admin-list" && mode === "admin-shape") {
    return {
      "hydra:member": [
        {
          id: 10,
          visualId: "malformed-admin",
          description: "Malformed admin receipt",
          sum: 20,
          receiptDate: "2026-08-09T00:00:00.000Z",
          submitDate: "2026-08-09T00:00:00.000Z",
          status: "pending",
        },
      ],
      "hydra:totalItems": 1,
    };
  }

  return { id: "not-a-number" };
}

function faultResponse(
  operation: Operation,
  request: Request,
  url: URL,
): Response | null {
  const fault = faults.get(operation);
  if (fault === undefined) return null;

  const status = fault.status ?? 200;
  const body = fault.malformed
    ? malformedBody(operation, fault.malformed)
    : { error: "synthetic fault" };
  const bodyShape: BodyShape = {
    kind: "json",
    keys: isRecord(body) ? Object.keys(body).sort() : [],
  };
  record(request, url, bodyShape, status);
  return jsonResponse(body, status);
}

function parseId(pathname: string, prefix: string): number | null {
  const match = pathname.match(new RegExp(`^${prefix}/(\\d+)$`));
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}


async function handleProfile(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("profile", request, url);
  if (fault !== null) return fault;
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({
    id: 7,
    firstName: "Trace",
    lastName: "User",
    email: "trace@example.test",
    phone: null,
    department: "Trondheim",
    fieldOfStudy: null,
    profilePhoto: null,
  });
}

async function handlePersonalList(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-list", request, url);
  if (fault !== null) return fault;

  const status = url.searchParams.get("status");
  const rows = status === null
    ? personalReceipts
    : personalReceipts.filter((receipt) => receipt.status === status);
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({
    "hydra:member": rows,
    "hydra:totalItems": rows.length,
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
      if (name === "file" && value instanceof File && value.size > 0) {
        filePresent = true;
      }
    }
    return {
      form,
      bodyShape: { kind: "multipart", fields: fields.sort(), filePresent },
    };
  } catch {
    return {
      form: null,
      bodyShape: { kind: "multipart", fields: [], filePresent: false },
    };
  }
}

function updateReceiptFromForm(form: FormData, receipt: ReceiptWire): boolean {
  const description = form.get("description");
  const sum = form.get("sum");
  const receiptDate = form.get("receiptDate");
  if (
    typeof description !== "string" ||
    typeof sum !== "string" ||
    typeof receiptDate !== "string" ||
    !form.has("file")
  ) {
    return false;
  }
  const numericSum = Number(sum);
  if (description.length === 0 || !Number.isFinite(numericSum) || numericSum <= 0) {
    return false;
  }
  receipt.description = description;
  receipt.sum = numericSum;
  receipt.receiptDate = `${receiptDate}T00:00:00.000Z`;
  return true;
}

async function handlePersonalCreate(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-create", request, url);
  if (fault !== null) return fault;

  const parsed = await parseMultipart(request);
  if (
    parsed.form === null ||
    !parsed.bodyShape.fields.includes("description") ||
    !parsed.bodyShape.fields.includes("sum") ||
    !parsed.bodyShape.fields.includes("receiptDate") ||
    !parsed.bodyShape.fields.includes("file") ||
    parsed.bodyShape.fields.includes("picture") ||
    !parsed.bodyShape.filePresent
  ) {
    record(request, url, parsed.bodyShape, 422);
    return jsonResponse({ error: "invalid multipart shape" }, 422);
  }

  const existing = personalReceipts.find((receipt) => receipt.id === 99);
  const receipt: ReceiptWire = existing ?? {
    id: 99,
    visualId: "personal-99",
    description: "",
    sum: 1,
    receiptDate: "2026-08-10T00:00:00.000Z",
    submitDate: "2026-08-10T00:00:00.000Z",
    status: "pending",
    refundDate: null,
  };
  if (!updateReceiptFromForm(parsed.form, receipt)) {
    record(request, url, parsed.bodyShape, 422);
    return jsonResponse({ error: "invalid receipt input" }, 422);
  }
  if (existing === undefined) personalReceipts.push(receipt);
  transitions.push("personal:create:99");
  record(request, url, parsed.bodyShape, 201);
  return jsonResponse({ id: 99 }, 201);
}

async function handlePersonalUpdate(
  request: Request,
  url: URL,
  id: number,
): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-update", request, url);
  if (fault !== null) return fault;

  const receipt = personalReceipts.find((item) => item.id === id);
  if (receipt === undefined) {
    record(request, url, { kind: "empty" }, 404);
    return jsonResponse({ error: "not found" }, 404);
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      record(request, url, { kind: "json", keys: [] }, 422);
      return jsonResponse({ error: "invalid json" }, 422);
    }
    if (!isRecord(body)) {
      record(request, url, { kind: "json", keys: [] }, 422);
      return jsonResponse({ error: "invalid json" }, 422);
    }
    const description = body.description;
    const sum = body.sum;
    const receiptDate = body.receiptDate;
    if (
      typeof description !== "string" ||
      typeof sum !== "number" ||
      !Number.isFinite(sum) ||
      sum <= 0 ||
      typeof receiptDate !== "string"
    ) {
      record(request, url, { kind: "json", keys: Object.keys(body).sort() }, 422);
      return jsonResponse({ error: "invalid receipt input" }, 422);
    }
    receipt.description = description;
    receipt.sum = sum;
    receipt.receiptDate = `${receiptDate}T00:00:00.000Z`;
    transitions.push(`personal:update:${id}`);
    record(request, url, { kind: "json", keys: Object.keys(body).sort() }, 204);
    return noContent();
  }

  const parsed = await parseMultipart(request);
  if (parsed.form === null || !updateReceiptFromForm(parsed.form, receipt)) {
    record(request, url, parsed.bodyShape, 422);
    return jsonResponse({ error: "invalid multipart shape" }, 422);
  }
  transitions.push(`personal:update-file:${id}`);
  record(request, url, parsed.bodyShape, 204);
  return noContent();
}

async function handlePersonalDelete(
  request: Request,
  url: URL,
  id: number,
): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("personal-delete", request, url);
  if (fault !== null) return fault;

  const before = personalReceipts.length;
  personalReceipts = personalReceipts.filter((receipt) => receipt.id !== id);
  if (personalReceipts.length === before) {
    record(request, url, { kind: "empty" }, 404);
    return jsonResponse({ error: "not found" }, 404);
  }
  transitions.push(`personal:delete:${id}`);
  record(request, url, { kind: "empty" }, 204);
  return noContent();
}

async function handleAdminList(request: Request, url: URL): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("admin-list", request, url);
  if (fault !== null) return fault;

  const status = url.searchParams.get("status");
  const rows = status === null
    ? adminReceipts
    : adminReceipts.filter((receipt) => receipt.status === status);
  record(request, url, { kind: "empty" }, 200);
  return jsonResponse({
    "hydra:member": rows,
    "hydra:totalItems": rows.length,
  });
}

async function handleAdminStatus(
  request: Request,
  url: URL,
  id: number,
): Promise<Response> {
  const authFailure = unauthorized(request, url);
  if (authFailure !== null) return authFailure;
  const fault = faultResponse("admin-status", request, url);
  if (fault !== null) return fault;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    record(request, url, { kind: "json", keys: [] }, 422);
    return jsonResponse({ error: "invalid json" }, 422);
  }
  if (!isRecord(body)) {
    record(request, url, { kind: "json", keys: [] }, 422);
    return jsonResponse({ error: "invalid status" }, 422);
  }
  const bodyKeys = Object.keys(body).sort();
  const status = typeof body.status === "string" ? body.status : null;
  if (status !== "pending" && status !== "refunded" && status !== "rejected") {
    record(request, url, { kind: "json", keys: bodyKeys }, 422);
    return jsonResponse({ error: "invalid status" }, 422);
  }

  const receipt = adminReceipts.find((item) => item.id === id);
  if (receipt === undefined) {
    record(request, url, { kind: "json", keys: bodyKeys }, 404);
    return jsonResponse({ error: "not found" }, 404);
  }
  receipt.status = status;
  receipt.refundDate = status === "refunded" ? "2026-08-10T00:00:00.000Z" : null;
  transitions.push(`admin:${id}:${status}`);
  record(request, url, { kind: "json", keys: bodyKeys }, 204);
  return noContent();
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/me/profile" && request.method === "GET") {
    return handleProfile(request, url);
  }
  if (url.pathname === "/api/receipts" && request.method === "GET") {
    return handlePersonalList(request, url);
  }
  if (url.pathname === "/api/receipts" && request.method === "POST") {
    return handlePersonalCreate(request, url);
  }

  const personalId = parseId(url.pathname, "/api/receipts");
  if (personalId !== null && request.method === "PUT") {
    return handlePersonalUpdate(request, url, personalId);
  }
  if (personalId !== null && request.method === "POST") {
    return handlePersonalUpdate(request, url, personalId);
  }
  if (personalId !== null && request.method === "DELETE") {
    return handlePersonalDelete(request, url, personalId);
  }

  if (url.pathname === "/api/admin/receipts" && request.method === "GET") {
    return handleAdminList(request, url);
  }

  const adminMatch = url.pathname.match(/^\/api\/admin\/receipts\/(\d+)\/status$/);
  const adminId = adminMatch === null ? null : Number(adminMatch[1]);
  if (
    adminId !== null &&
    url.pathname.endsWith("/status") &&
    request.method === "PUT"
  ) {
    return handleAdminStatus(request, url, adminId);
  }

  return jsonResponse({ error: "not found" }, 404);
}

async function control(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noContent(400);
  }
  if (!isRecord(body) || typeof body.operation !== "string" || !isOperation(body.operation)) {
    return noContent(400);
  }
  if (body.clear === true) {
    faults.delete(body.operation);
    return noContent();
  }
  const fault: Fault = {};
  if (body.status !== undefined) {
    if (
      typeof body.status !== "number" ||
      !Number.isInteger(body.status) ||
      body.status < 400 ||
      body.status > 599
    ) {
      return noContent(400);
    }
    fault.status = body.status;
  }
  if (body.malformed !== undefined) {
    if (typeof body.malformed !== "string" || !isMalformedMode(body.malformed)) {
      return noContent(400);
    }
    fault.malformed = body.malformed;
  }
  if (fault.status === undefined && fault.malformed === undefined) {
    return noContent(400);
  }
  faults.set(body.operation, fault);
  return noContent();
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__receipt_stub/ready" && request.method === "GET") {
    return jsonResponse({ ready: true });
  }
  if (url.pathname === "/__receipt_stub/reset" && request.method === "POST") {
    resetState();
    return noContent();
  }
  if (url.pathname === "/__receipt_stub/control" && request.method === "POST") {
    return control(request);
  }
  if (url.pathname === "/__receipt_stub/evidence" && request.method === "GET") {
    return jsonResponse({ requests: evidence, transitions });
  }
  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, url);
  }
  return jsonResponse({ error: "not found" }, 404);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--port" || args[1] !== "8787") {
  throw new Error("receipt stub requires --port 8787");
}

resetState();
let inFlight = 0;
let drained: (() => void) | undefined;
let shuttingDown = false;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8787,
  fetch(request) {
    inFlight += 1;
    return handleRequest(request)
      .catch(() => jsonResponse({ error: "stub failure" }, 500))
      .finally(() => {
        inFlight -= 1;
        if (inFlight === 0 && drained !== undefined) {
          drained();
          drained = undefined;
        }
      });
  },
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.stop();
  if (inFlight > 0) {
    await new Promise<void>((resolve) => {
      drained = resolve;
    });
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.log(`receipt stub ready on http://${server.hostname}:${server.port}`);
