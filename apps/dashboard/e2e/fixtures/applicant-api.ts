type BunApplicantServer = {
  hostname: string;
  port: number;
  stop(): Promise<void>;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunApplicantServer;
};

type Operation =
  | "applications-list"
  | "users-list"
  | "schemas-list"
  | "assign";

type MalformedMode =
  | "missing-hydra-member"
  | "wrong-hydra-member-type"
  | "unknown-application-status"
  | "missing-activeUsers"
  | "wrong-inactiveUsers-type"
  | "missing-user-field"
  | "hydra-envelope"
  | "missing-questions";

type Fault = { status?: number; malformed?: MalformedMode };

type RawApplication = {
  id: number;
  userName: string;
  userEmail: string;
  applicationStatus: number;
  interviewStatus: string | null;
  interviewer: string | null;
  interviewScheduled: string | null;
  previousParticipation: boolean;
};

type RawUser = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
};

type RawSchema = {
  id: number;
  name: string;
  questions: Array<{ id: number; text: string; type: string }>;
};

type BodyShape =
  | { kind: "empty" }
  | { kind: "object"; keys: string[] }
  | { kind: "array"; keys: string[] }
  | { kind: "json"; keys: string[] };

type RequestEvidence = {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  auth: "bearer-present" | "missing";
  accept: string;
  contentType: string;
  response: string;
  body: BodyShape;
};

const operations: Record<Operation, true> = {
  "applications-list": true,
  "users-list": true,
  "schemas-list": true,
  assign: true,
};

const malformedModes: Record<MalformedMode, true> = {
  "missing-hydra-member": true,
  "wrong-hydra-member-type": true,
  "unknown-application-status": true,
  "missing-activeUsers": true,
  "wrong-inactiveUsers-type": true,
  "missing-user-field": true,
  "hydra-envelope": true,
  "missing-questions": true,
};

const statuses = new Set([401, 403, 404, 409, 422, 429, 500]);

let assigned = false;
let faults = new Map<Operation, Fault>();
let requests: RequestEvidence[] = [];
let transitions: string[] = [];
let inFlight = 0;
let shuttingDown = false;
let drained: (() => void) | undefined;
let server: BunApplicantServer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && value in operations;
}

function isMalformedMode(value: unknown): value is MalformedMode {
  return typeof value === "string" && value in malformedModes;
}

function resetState(): void {
  assigned = false;
  faults = new Map();
  requests = [];
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

function authKind(request: Request): "bearer-present" | "missing" {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") && authorization.length > 7
    ? "bearer-present"
    : "missing";
}

function observedAccept(request: Request): string {
  const accept = request.headers.get("accept");
  return accept === null || accept === "*/*" ? "absent" : accept;
}

function bodyShapeForJson(value: unknown): BodyShape {
  return {
    kind: "json",
    keys: isRecord(value) ? Object.keys(value) : [],
  };
}

function record(
  request: Request,
  url: URL,
  status: number,
  response: string,
  body: BodyShape,
): void {
  requests.push({
    method: request.method,
    path: url.pathname,
    query: queryValues(url),
    status,
    auth: authKind(request),
    accept: observedAccept(request),
    contentType: request.headers.get("content-type") ?? "absent",
    response,
    body,
  });
}

function unauthorized(request: Request, url: URL): Response {
  record(request, url, 401, "unauthorized", { kind: "empty" });
  return jsonResponse({ error: "unauthorized" }, 401);
}

function profileBody(): Record<string, unknown> {
  return {
    id: 900,
    firstName: "Admin",
    lastName: "Test",
    email: "admin.profile@example.invalid",
    phone: null,
    department: "Syntetisk",
    fieldOfStudy: null,
    profilePhoto: null,
  };
}

function applicationBody(): {
  "hydra:member": RawApplication[];
  "hydra:totalItems": number;
} {
  return {
    "hydra:member": [
      {
        id: 101,
        userName: "Applicant One",
        userEmail: "applicant-101@example.invalid",
        applicationStatus: 1,
        interviewStatus: assigned ? "Pending" : null,
        interviewer: assigned ? "Intervjuer Test" : null,
        interviewScheduled: null,
        previousParticipation: false,
      },
      {
        id: 102,
        userName: "Applicant Two",
        userEmail: "applicant-102@example.invalid",
        applicationStatus: 1,
        interviewStatus: null,
        interviewer: null,
        interviewScheduled: null,
        previousParticipation: false,
      },
    ],
    "hydra:totalItems": 2,
  };
}

function usersBody(): {
  activeUsers: RawUser[];
  inactiveUsers: RawUser[];
} {
  return {
    activeUsers: [
      {
        id: 201,
        firstName: "Intervjuer",
        lastName: "Test",
        email: "interviewer-201@example.invalid",
        role: "ROLE_TEAM_LEADER",
      },
      {
        id: 202,
        firstName: "Admin",
        lastName: "Test",
        email: "admin-202@example.invalid",
        role: "ROLE_ADMIN",
      },
      {
        id: 203,
        firstName: "Uegnet",
        lastName: "Test",
        email: "ineligible-203@example.invalid",
        role: "ROLE_MEMBER",
      },
    ],
    inactiveUsers: [
      {
        id: 204,
        firstName: "Inaktiv",
        lastName: "Test",
        email: "inactive-204@example.invalid",
        role: "ROLE_TEAM_LEADER",
      },
    ],
  };
}

function schemasBody(): RawSchema[] {
  return [
    {
      id: 301,
      name: "Førstegangsintervju",
      questions: [
        {
          id: 311,
          text: "Fortell kort om motivasjonen din.",
          type: "text",
        },
      ],
    },
  ];
}

function faultResponse(
  operation: Operation,
  request: Request,
  url: URL,
  body: BodyShape = { kind: "empty" },
): Response | null {
  const fault = faults.get(operation);
  if (fault?.status === undefined) return null;

  const responseBody =
    fault.status === 422
      ? {
          violations: [
            {
              propertyPath: "interviewerId",
              message: "Synthetic assignment validation failure",
            },
          ],
        }
      : { error: "synthetic fault" };
  record(request, url, fault.status, "fault", body);
  return jsonResponse(responseBody, fault.status);
}

function malformedApplicationBody(mode: MalformedMode): unknown {
  const body = applicationBody();
  if (mode === "missing-hydra-member") {
    return { "hydra:totalItems": body["hydra:totalItems"] };
  }
  if (mode === "wrong-hydra-member-type") {
    return { ...body, "hydra:member": "not-an-array" };
  }
  if (mode === "unknown-application-status") {
    const [first, ...rest] = body["hydra:member"];
    return {
      ...body,
      "hydra:member": [
        { ...first, applicationStatus: 999 },
        ...rest,
      ],
    };
  }
  return body;
}

function malformedUsersBody(mode: MalformedMode): unknown {
  const body = usersBody();
  if (mode === "missing-activeUsers") {
    return { inactiveUsers: body.inactiveUsers };
  }
  if (mode === "wrong-inactiveUsers-type") {
    return { ...body, inactiveUsers: "not-an-array" };
  }
  if (mode === "missing-user-field") {
    const [first, ...rest] = body.activeUsers;
    const { email: _email, ...withoutEmail } = first;
    return { ...body, activeUsers: [withoutEmail, ...rest] };
  }
  return body;
}

function malformedSchemasBody(mode: MalformedMode): unknown {
  const body = schemasBody();
  if (mode === "hydra-envelope") {
    return { "hydra:member": body };
  }
  if (mode === "missing-questions") {
    const [{ questions: _questions, ...withoutQuestions }] = body;
    return [withoutQuestions];
  }
  return body;
}

function faultBody(operation: Operation, mode: MalformedMode): unknown {
  if (operation === "applications-list") {
    return malformedApplicationBody(mode);
  }
  if (operation === "users-list") {
    return malformedUsersBody(mode);
  }
  return malformedSchemasBody(mode);
}

function faultMalformedResponse(
  operation: Operation,
  request: Request,
  url: URL,
  mode: MalformedMode,
): Response {
  const body = faultBody(operation, mode);
  const response =
    operation === "applications-list"
      ? "hydra-applications"
      : operation === "users-list"
        ? "plain-users"
        : "schema-array";
  const shape: BodyShape =
    operation === "applications-list"
      ? { kind: "object", keys: Object.keys(body as Record<string, unknown>) }
      : operation === "users-list"
        ? { kind: "object", keys: Object.keys(body as Record<string, unknown>) }
        : { kind: "array", keys: ["id", "name", "questions"] };
  record(request, url, 200, response, shape);
  return jsonResponse(body);
}

async function handleProfile(request: Request, url: URL): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  const body = profileBody();
  record(request, url, 200, "user-profile", {
    kind: "object",
    keys: Object.keys(body),
  });
  return jsonResponse(body);
}

async function handleApplications(
  request: Request,
  url: URL,
): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  const fault = faults.get("applications-list");
  const statusResponse = faultResponse("applications-list", request, url);
  if (statusResponse !== null) return statusResponse;
  if (fault?.malformed !== undefined) {
    return faultMalformedResponse(
      "applications-list",
      request,
      url,
      fault.malformed,
    );
  }

  const body = applicationBody();
  record(request, url, 200, "hydra-applications", {
    kind: "object",
    keys: ["hydra:member", "hydra:totalItems"],
  });
  return jsonResponse(body);
}

async function handleUsers(request: Request, url: URL): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  const fault = faults.get("users-list");
  const statusResponse = faultResponse("users-list", request, url);
  if (statusResponse !== null) return statusResponse;
  if (fault?.malformed !== undefined) {
    return faultMalformedResponse("users-list", request, url, fault.malformed);
  }

  const body = usersBody();
  record(request, url, 200, "plain-users", {
    kind: "object",
    keys: ["activeUsers", "inactiveUsers"],
  });
  return jsonResponse(body);
}

async function handleSchemas(request: Request, url: URL): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  const fault = faults.get("schemas-list");
  const statusResponse = faultResponse("schemas-list", request, url);
  if (statusResponse !== null) return statusResponse;
  if (fault?.malformed !== undefined) {
    return faultMalformedResponse(
      "schemas-list",
      request,
      url,
      fault.malformed,
    );
  }

  const body = schemasBody();
  record(request, url, 200, "schema-array", {
    kind: "array",
    keys: ["id", "name", "questions"],
  });
  return jsonResponse(body);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isExactAssignment(value: unknown): value is {
  applicationId: number;
  interviewerId: number;
  schemaId: number;
} {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "applicationId" &&
    keys[1] === "interviewerId" &&
    keys[2] === "schemaId" &&
    value.applicationId === 101 &&
    value.interviewerId === 201 &&
    value.schemaId === 301 &&
    typeof value.applicationId === "number" &&
    typeof value.interviewerId === "number" &&
    typeof value.schemaId === "number"
  );
}

async function handleAssign(request: Request, url: URL): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  const body = await readJson(request);
  const bodyShape = bodyShapeForJson(body);
  const statusResponse = faultResponse("assign", request, url, bodyShape);
  if (statusResponse !== null) return statusResponse;

  if (
    request.headers.get("content-type")?.toLowerCase() !== "application/json" ||
    observedAccept(request) !== "absent" ||
    !isExactAssignment(body)
  ) {
    record(request, url, 422, "fault", bodyShape);
    return jsonResponse(
      {
        violations: [
          {
            propertyPath: "assignment",
            message: "Synthetic assignment request shape is invalid",
          },
        ],
      },
      422,
    );
  }

  assigned = true;
  transitions.push("application-assigned:101:201:301");
  record(request, url, 204, "void", bodyShape);
  return noContent();
}

async function handleUnlistedApi(
  request: Request,
  url: URL,
): Promise<Response> {
  if (authKind(request) === "missing") return unauthorized(request, url);
  record(request, url, 404, "unlisted-api-404", { kind: "empty" });
  return noContent(404);
}

function validControlKeys(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body).sort();
  return (
    keys.length === 2 &&
    keys.includes("operation") &&
    (keys.includes("malformed") || keys.includes("status"))
  );
}

async function handleControl(request: Request): Promise<Response> {
  if (request.method !== "POST") return noContent(405);
  const body = await readJson(request);
  if (!isRecord(body)) return jsonResponse({ error: "invalid control" }, 400);

  if (body.clear === true && Object.keys(body).length === 1) {
    faults.clear();
    return noContent();
  }

  if (!validControlKeys(body) || !isOperation(body.operation)) {
    return jsonResponse({ error: "invalid control" }, 400);
  }

  const operation = body.operation;
  if ("status" in body) {
    if (typeof body.status !== "number" || !statuses.has(body.status)) {
      return jsonResponse({ error: "invalid control" }, 400);
    }
    faults.clear();
    faults.set(operation, { status: body.status });
    return noContent();
  }

  if (!isMalformedMode(body.malformed)) {
    return jsonResponse({ error: "invalid control" }, 400);
  }
  const validOperation =
    operation === "applications-list" ||
    operation === "users-list" ||
    operation === "schemas-list";
  if (!validOperation) return jsonResponse({ error: "invalid control" }, 400);
  faults.clear();
  faults.set(operation, { malformed: body.malformed });
  return noContent();
}

function evidenceBody(): {
  seed: string;
  requests: RequestEvidence[];
  transitions: string[];
  faults: Array<{ operation: Operation; status?: number; malformed?: MalformedMode }>;
} {
  return {
    seed: "applicant-assignment-0018",
    requests: requests.slice(),
    transitions: transitions.slice(),
    faults: [...faults.entries()].map(([operation, fault]) => ({
      operation,
      ...fault,
    })),
  };
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__applicant_stub/ready" && request.method === "GET") {
    return jsonResponse({ ready: true });
  }
  if (url.pathname === "/__applicant_stub/reset") {
    if (request.method !== "POST") return noContent(405);
    resetState();
    return noContent();
  }
  if (url.pathname === "/__applicant_stub/control") {
    return handleControl(request);
  }
  if (url.pathname === "/__applicant_stub/evidence" && request.method === "GET") {
    return jsonResponse(evidenceBody());
  }
  if (url.pathname === "/__applicant_stub/shutdown") {
    const response = noContent();
    queueMicrotask(() => void shutdown());
    return response;
  }

  if (url.pathname === "/api/me/profile" && request.method === "GET") {
    return handleProfile(request, url);
  }
  if (
    url.pathname === "/api/admin/applications" &&
    request.method === "GET"
  ) {
    return handleApplications(request, url);
  }
  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    return handleUsers(request, url);
  }
  if (
    url.pathname === "/api/admin/interview-schemas" &&
    request.method === "GET"
  ) {
    return handleSchemas(request, url);
  }
  if (
    url.pathname === "/api/admin/interviews/assign" &&
    request.method === "POST"
  ) {
    return handleAssign(request, url);
  }
  if (url.pathname.startsWith("/api/")) {
    return handleUnlistedApi(request, url);
  }
  return noContent(404);
}

function trackedFetch(request: Request): Promise<Response> {
  inFlight += 1;
  return handleRequest(request)
    .catch(() => jsonResponse({ error: "stub failure" }, 500))
    .finally(() => {
      inFlight -= 1;
      if (shuttingDown && inFlight === 0 && drained !== undefined) {
        const resolve = drained;
        drained = undefined;
        resolve();
      }
    });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (inFlight > 0) {
    await new Promise<void>((resolve) => {
      drained = resolve;
    });
  }
  await server.stop();
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--port" || args[1] !== "8789") {
  throw new Error("applicant stub requires --port 8789");
}

server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8789,
  fetch: trackedFetch,
});

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.log(`applicant stub ready on http://${server.hostname}:${server.port}`);

export {};
