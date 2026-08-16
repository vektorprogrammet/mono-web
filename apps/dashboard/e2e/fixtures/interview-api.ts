import { randomUUID } from "node:crypto";

type BunServer = {
  hostname: string;
  port: number;
  stop(): Promise<void>;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
};

type SchedulingStatus =
  | "created"
  | "pending"
  | "accepted"
  | "request_new_time"
  | "cancelled"
  | "no_contact"
  | "conducted";

type Interview = {
  id: string;
  applicationId: string;
  applicantLabel: string;
  cycle: { departmentId: string; semesterId: string };
  interviewerLabel: string;
  schedulingStatus: SchedulingStatus;
  interviewTime: string | null;
  room: string | null;
  campus: string | null;
};

type FixtureActor = {
  readonly id: string;
  readonly departmentGrants: readonly string[];
  readonly canRead: boolean;
  readonly canSchedule: boolean;
  readonly isAdministrator: boolean;
};

type Evidence = {
  method: string;
  operation: string;
  actor: string;
  status: number;
  identifiers: Record<string, string>;
  bodyKeys: string[];
};

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8790;
const DASHBOARD_ORIGIN =
  process.env.DASHBOARD_ORIGIN?.trim() || "http://127.0.0.1:5173";
const CONTROL_HEADER = "x-interview-fixture-control";
const CONTROL_KEY = process.env.INTERVIEW_FIXTURE_CONTROL_KEY?.trim() ?? "";
const LEADER = "leader-trondheim@example.invalid";
const INTERVIEWER = "interviewer-trondheim@example.invalid";
const MEMBER = "member-trondheim@example.invalid";
const BERGEN_LEADER = "leader-bergen@example.invalid";
const DEPARTMENT_ID = "dep-trd-1";
const SEMESTER_ID = "sem-2026-høst";
const INTERVIEW_ID = "interview-001";
const ALLOWED_NOW = Date.parse("2026-08-01T00:00:00+02:00");
const CAPABILITY_LIFETIME_MS = 30 * 60 * 1000;

if (CONTROL_KEY.length < 32) {
  throw new Error("INTERVIEW_FIXTURE_CONTROL_KEY must contain at least 32 characters");
}
let interview: Interview | null;
let capability: string;
let capabilityCycle: { departmentId: string; semesterId: string };
let capabilityExpiresAt: number;
let capabilityUsed: boolean;
let observations: Evidence[];
let transitions: string[];
let server: BunServer;
let inFlight = 0;
let shuttingDown = false;
let drained: (() => void) | undefined;

function resetState(): void {
  interview = {
    id: INTERVIEW_ID,
    applicationId: "app-001",
    applicantLabel: "Applicant One",
    cycle: { departmentId: DEPARTMENT_ID, semesterId: SEMESTER_ID },
    interviewerLabel: INTERVIEWER,
    schedulingStatus: "created",
    interviewTime: null,
    room: null,
    campus: null,
  };
  capability = randomUUID();
  capabilityCycle = { departmentId: DEPARTMENT_ID, semesterId: SEMESTER_ID };
  capabilityExpiresAt = Date.now() + CAPABILITY_LIFETIME_MS;
  capabilityUsed = false;
  observations = [];
  transitions = [];
}

const corsHeaders = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": `Accept, Authorization, Content-Type, ${CONTROL_HEADER}`,
  vary: "Origin",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status, headers: corsHeaders });
}

function actorFor(request: Request): FixtureActor | null {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  switch (token) {
    case "fixture-leader-session":
      return {
        id: LEADER,
        departmentGrants: [DEPARTMENT_ID],
        canRead: true,
        canSchedule: true,
        isAdministrator: true,
      };
    case "fixture-interviewer-session":
      return {
        id: INTERVIEWER,
        departmentGrants: [DEPARTMENT_ID],
        canRead: true,
        canSchedule: false,
        isAdministrator: false,
      };
    case "fixture-member-session":
      return {
        id: MEMBER,
        departmentGrants: [DEPARTMENT_ID],
        canRead: false,
        canSchedule: false,
        isAdministrator: false,
      };
    case "fixture-bergen-session":
      return {
        id: BERGEN_LEADER,
        departmentGrants: ["dep-bergen-1"],
        canRead: true,
        canSchedule: true,
        isAdministrator: true,
      };
    default:
      return null;
  }
}

function actorLabel(request: Request): string {
  return actorFor(request)?.id ?? "anonymous";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function cycleFrom(url: URL, body?: Record<string, unknown>): {
  departmentId: string;
  semesterId: string;
} | null {
  const departmentId = body?.departmentId ?? url.searchParams.get("departmentId");
  const semesterId = body?.semesterId ?? url.searchParams.get("semesterId");
  return typeof departmentId === "string" && typeof semesterId === "string"
    ? { departmentId, semesterId }
    : null;
}

function cycleIsKnown(cycle: { departmentId: string; semesterId: string }): boolean {
  return cycle.departmentId === DEPARTMENT_ID && cycle.semesterId === SEMESTER_ID;
}

function cycleMatchesInterview(
  cycle: { departmentId: string; semesterId: string },
  value: Interview,
): boolean {
  return cycle.departmentId === value.cycle.departmentId &&
    cycle.semesterId === value.cycle.semesterId;
}

function actorMayRead(actor: FixtureActor | null): boolean {
  return actor?.canRead === true;
}

function actorMayReadInterview(actor: FixtureActor, value: Interview): boolean {
  return actor.isAdministrator || actor.id === value.interviewerLabel;
}

function record(
  request: Request,
  operation: string,
  status: number,
  identifiers: Record<string, string> = {},
  body: Record<string, unknown> | null = null,
): Response {
  observations.push({
    method: request.method,
    operation,
    actor: actorLabel(request),
    status,
    identifiers,
    bodyKeys: body === null ? [] : Object.keys(body).sort(),
  });
  return empty(status);
}

function recordedJson(
  request: Request,
  operation: string,
  body: unknown,
  status: number,
  identifiers: Record<string, string> = {},
): Response {
  observations.push({
    method: request.method,
    operation,
    actor: actorLabel(request),
    status,
    identifiers,
    bodyKeys: [],
  });
  return json(body, status);
}

function validCapability(pathCapability: string): boolean {
  return pathCapability.length > 0 && pathCapability === capability && capabilityResolves();
}

function candidateView(): object | null {
  if (
    interview === null ||
    interview.interviewTime === null ||
    interview.room === null ||
    interview.campus === null
  ) {
    return null;
  }
  return {
    schedulingStatus: interview.schedulingStatus,
    interviewTime: interview.interviewTime,
    room: interview.room,
    campus: interview.campus,
  };
}

function capabilityResolves(): boolean {
  return (
    interview !== null &&
    interview.id === INTERVIEW_ID &&
    interview.cycle.departmentId === capabilityCycle.departmentId &&
    interview.cycle.semesterId === capabilityCycle.semesterId
  );
}

async function handleAssignedList(request: Request, url: URL): Promise<Response> {
  const actor = actorFor(request);
  const cycle = cycleFrom(url);
  if (cycle === null) return record(request, "list-assigned", 422);
  const ids = { departmentId: cycle.departmentId, semesterId: cycle.semesterId };
  if (actor === null || !actorMayRead(actor) || !actor.departmentGrants.includes(cycle.departmentId)) {
    return record(request, "list-assigned", 403, ids);
  }
  if (!cycleIsKnown(cycle)) return record(request, "list-assigned", 404, ids);
  const rows =
    interview === null ||
      !cycleMatchesInterview(cycle, interview) ||
      !actorMayReadInterview(actor, interview)
      ? []
      : [interview];
  return recordedJson(request, "list-assigned", rows, 200, ids);
}

async function handleAssignedRead(
  request: Request,
  url: URL,
  interviewId: string,
): Promise<Response> {
  const actor = actorFor(request);
  const cycle = cycleFrom(url);
  if (cycle === null) return record(request, "read-assigned", 422);
  const ids = {
    departmentId: cycle.departmentId,
    semesterId: cycle.semesterId,
    interviewId,
  };
  if (actor === null || !actorMayRead(actor) || !actor.departmentGrants.includes(cycle.departmentId)) {
    return record(request, "read-assigned", 403, ids);
  }
  if (
    !cycleIsKnown(cycle) ||
    interview === null ||
    interviewId !== interview.id ||
    !cycleMatchesInterview(cycle, interview)
  ) {
    return record(request, "read-assigned", 404, ids);
  }
  if (!actorMayReadInterview(actor, interview)) {
    return record(request, "read-assigned", 403, ids);
  }
  return recordedJson(request, "read-assigned", interview, 200, ids);
}

async function handleSchedule(
  request: Request,
  url: URL,
  interviewId: string,
): Promise<Response> {
  const body = await objectBody(request);
  const cycle = body === null ? null : cycleFrom(url, body);
  const ids: Record<string, string> = { interviewId };
  if (cycle !== null) {
    ids.departmentId = cycle.departmentId;
    ids.semesterId = cycle.semesterId;
  }
  if (body === null || cycle === null) return record(request, "schedule", 422, ids, body);
  const actor = actorFor(request);
  if (
    actor === null ||
    !actor.canSchedule ||
    !actor.departmentGrants.includes(cycle.departmentId)
  ) {
    return record(request, "schedule", 403, ids, body);
  }
  if (
    !cycleIsKnown(cycle) ||
    interview === null ||
    interviewId !== interview.id ||
    !cycleMatchesInterview(cycle, interview)
  ) {
    return record(request, "schedule", 404, ids, body);
  }
  if (interview.schedulingStatus !== "created") {
    return record(request, "schedule", 409, ids, body);
  }
  const { interviewTime, room, campus } = body;
  const parsedTime = typeof interviewTime === "string" ? Date.parse(interviewTime) : Number.NaN;
  if (
    typeof interviewTime !== "string" ||
    !Number.isFinite(parsedTime) ||
    parsedTime <= ALLOWED_NOW ||
    typeof room !== "string" ||
    room.trim().length === 0 ||
    typeof campus !== "string" ||
    campus.trim().length === 0
  ) {
    return record(request, "schedule", 422, ids, body);
  }
  interview = {
    ...interview,
    schedulingStatus: "pending",
    interviewTime,
    room,
    campus,
  };
  transitions.push("created -> pending");
  return record(request, "schedule", 204, ids, body);
}

async function handleCandidateRead(
  request: Request,
  pathCapability: string,
): Promise<Response> {
  if (!validCapability(pathCapability)) {
    return record(request, "read-candidate", 404);
  }
  if (Date.now() >= capabilityExpiresAt) {
    return record(request, "read-candidate", 409);
  }
  const view = candidateView();
  if (
    view === null ||
    (interview?.schedulingStatus !== "pending" && interview?.schedulingStatus !== "accepted")
  ) {
    return record(request, "read-candidate", 409);
  }
  return recordedJson(request, "read-candidate", view, 200);
}

async function handleCandidateAccept(
  request: Request,
  pathCapability: string,
): Promise<Response> {
  if (!validCapability(pathCapability)) {
    return record(request, "accept-candidate", 404);
  }
  if (Date.now() >= capabilityExpiresAt) {
    return record(request, "accept-candidate", 409);
  }
  if (capabilityUsed || interview?.schedulingStatus !== "pending") {
    return record(request, "accept-candidate", 409);
  }
  interview = { ...interview, schedulingStatus: "accepted" };
  capabilityUsed = true;
  transitions.push("pending -> accepted");
  return record(request, "accept-candidate", 204);
}

async function handleControl(request: Request): Promise<Response> {
  const body = await objectBody(request);
  if (body === null || typeof body.state !== "string") return empty(422);
  switch (body.state) {
    case "expired":
      capabilityExpiresAt = 0;
      return empty();
    case "missing":
      interview = null;
      return empty();
    case "cancelled":
    case "no_contact":
    case "conducted":
      if (interview === null) return empty(409);
      interview = { ...interview, schedulingStatus: body.state };
      return empty();
    case "wrong-cycle":
      if (interview === null) return empty(409);
      interview = { ...interview, cycle: { departmentId: "dep-bergen-1", semesterId: "sem-2026-høst" } };
      return empty();
    case "unknown-interview":
      if (interview === null) return empty(409);
      interview = { ...interview, id: "interview-unknown" };
      return empty();
    default:
      return empty(422);
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== DASHBOARD_ORIGIN) return empty(403);
  if (request.method === "OPTIONS") return empty(origin === DASHBOARD_ORIGIN ? 204 : 403);

  if (url.pathname === "/__interview_fixture/health" && request.method === "GET") {
    return json({ ready: true });
  }

  const isControlRequest = url.pathname.startsWith("/__interview_fixture/");
  const isCandidateRequest = url.pathname.startsWith("/api/interview-responses/");
  const hasControlAuthority =
    request.headers.get(CONTROL_HEADER) === CONTROL_KEY ||
    request.headers.get("authorization") === `Bearer ${CONTROL_KEY}`;
  if ((isControlRequest || isCandidateRequest) && !hasControlAuthority) {
    return empty(401);
  }
  if (url.pathname === "/__interview_fixture/reset" && request.method === "POST") {
    resetState();
    return empty();
  }
  if (url.pathname === "/__interview_fixture/response-url" && request.method === "GET") {
    return json({ url: `/interview-response/${encodeURIComponent(capability)}` });
  }
  if (url.pathname === "/__interview_fixture/evidence" && request.method === "GET") {
    return json({
      seed: "foldkit-interview-0021",
      requests: observations.slice(),
      transitions: transitions.slice(),
    });
  }
  if (url.pathname === "/__interview_fixture/control" && request.method === "POST") {
    return handleControl(request);
  }
  if (url.pathname === "/api/admin/interviews/assigned" && request.method === "GET") {
    return handleAssignedList(request, url);
  }

  const scheduleMatch = url.pathname.match(/^\/api\/admin\/interviews\/assigned\/([^/]+)\/schedule$/);
  if (scheduleMatch !== null && request.method === "PUT") {
    return handleSchedule(request, url, decodeURIComponent(scheduleMatch[1] ?? ""));
  }
  const assignedMatch = url.pathname.match(/^\/api\/admin\/interviews\/assigned\/([^/]+)$/);
  if (assignedMatch !== null && request.method === "GET") {
    return handleAssignedRead(request, url, decodeURIComponent(assignedMatch[1] ?? ""));
  }
  const acceptMatch = url.pathname.match(/^\/api\/interview-responses\/([^/]+)\/accept$/);
  if (acceptMatch !== null && request.method === "POST") {
    return handleCandidateAccept(request, decodeURIComponent(acceptMatch[1] ?? ""));
  }
  const responseMatch = url.pathname.match(/^\/api\/interview-responses\/([^/]+)$/);
  if (responseMatch !== null && request.method === "GET") {
    return handleCandidateRead(request, decodeURIComponent(responseMatch[1] ?? ""));
  }
  return empty(404);
}

function trackedFetch(request: Request): Promise<Response> {
  inFlight += 1;
  return handle(request)
    .catch(() => json({ error: "fixture failure" }, 500))
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
const portArgument = args[0] === "--port" ? args[1] : undefined;
const configuredPort = Number(portArgument ?? process.env.INTERVIEW_FIXTURE_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("interview fixture requires a valid loopback port");
}
resetState();
server = Bun.serve({ hostname: HOST, port: configuredPort, fetch: trackedFetch });
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.log(`interview fixture ready on http://${server.hostname}:${server.port}`);

export {};

