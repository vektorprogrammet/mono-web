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
  id: number;
  applicantName: string;
  interviewerName: string | null;
  scheduled: string | null;
  status: SchedulingStatus;
  interviewed: boolean;
  coInterviewer: string | null;
  room: string | null;
  campus: string | null;
  mapLink: string | null;
  responseCode: string | null;
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
const INTERVIEW_ID = 1;
const ALLOWED_NOW = Date.parse("2026-08-01T00:00:00+02:00");
const CAPABILITY_LIFETIME_MS = 30 * 60 * 1000;

if (CONTROL_KEY.length < 32) {
  throw new Error("INTERVIEW_FIXTURE_CONTROL_KEY must contain at least 32 characters");
}
let interview: Interview | null;
let capability: string;
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
    applicantName: "Applicant One",
    interviewerName: INTERVIEWER,
    scheduled: null,
    status: "created",
    interviewed: false,
    coInterviewer: null,
    room: null,
    campus: null,
    mapLink: null,
    responseCode: null,
  };
  capability = randomUUID();
  capabilityExpiresAt = Date.now() + CAPABILITY_LIFETIME_MS;
  capabilityUsed = false;
  observations = [];
  transitions = [];
}
const corsHeaders = {
  "access-control-allow-origin": DASHBOARD_ORIGIN,
  "access-control-allow-methods": "GET, POST, OPTIONS",
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
        departmentGrants: ["dep-trd-1"],
        canRead: true,
        canSchedule: true,
        isAdministrator: true,
      };
    case "fixture-interviewer-session":
      return {
        id: INTERVIEWER,
        departmentGrants: ["dep-trd-1"],
        canRead: true,
        canSchedule: false,
        isAdministrator: false,
      };
    case "fixture-member-session":
      return {
        id: MEMBER,
        departmentGrants: ["dep-trd-1"],
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


function actorMayRead(actor: FixtureActor | null): boolean {
  return actor?.canRead === true;
}

function actorMayReadInterview(actor: FixtureActor, value: Interview): boolean {
  return actor.isAdministrator || actor.id === value.interviewerName;
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

function statusLabel(status: SchedulingStatus): string {
  switch (status) {
    case "created":
      return "Ikke satt opp";
    case "pending":
      return "Ingen svar";
    case "accepted":
      return "Akseptert";
    case "request_new_time":
      return "Ny tid ønskes";
    case "cancelled":
      return "Kansellert";
    case "no_contact":
      return "Ikke oppnådd kontakt";
    case "conducted":
      return "Gjennomført";
  }
}

function interviewWire(value: Interview): object {
  return {
    id: value.id,
    applicantName: value.applicantName,
    interviewerName: value.interviewerName,
    scheduled: value.scheduled,
    status: statusLabel(value.status),
    interviewed: value.interviewed,
    coInterviewer: value.coInterviewer,
    room: value.room,
    campus: value.campus,
    mapLink: value.mapLink,
  };
}

function candidateView(): object | null {
  if (
    interview === null ||
    interview.scheduled === null ||
    interview.room === null ||
    interview.campus === null
  ) {
    return null;
  }
  return {
    scheduled: interview.scheduled,
    room: interview.room,
    campus: interview.campus,
    mapLink: interview.mapLink,
    interviewerName: interview.interviewerName,
    status: statusLabel(interview.status),
    responseCode: interview.responseCode,
  };
}

function capabilityResolves(): boolean {
  return interview !== null && interview.id === INTERVIEW_ID;
}

async function handleList(request: Request): Promise<Response> {
  const actor = actorFor(request);
  if (actor === null || !actorMayRead(actor)) {
    return record(request, "list-interviews", 403);
  }
  const rows =
    interview !== null && actorMayReadInterview(actor, interview)
      ? [interviewWire(interview)]
      : [];
  return recordedJson(request, "list-interviews", { interviews: rows }, 200);
}

async function handleSchedule(
  request: Request,
  interviewId: string,
): Promise<Response> {
  const body = await objectBody(request);
  const ids = { interviewId };
  const actor = actorFor(request);
  if (actor === null || !actor.canSchedule) {
    return record(request, "schedule", 403, ids, body);
  }
  const parsedId = Number(interviewId);
  if (
    body === null ||
    !Number.isSafeInteger(parsedId) ||
    interview === null ||
    parsedId !== interview.id
  ) {
    return record(request, "schedule", 404, ids, body);
  }
  if (interview.status !== "created") {
    return record(request, "schedule", 409, ids, body);
  }
  const { datetime, room, campus, mapLink, from, to, message } = body;
  const parsedTime = typeof datetime === "string" ? Date.parse(datetime) : Number.NaN;
  if (
    typeof datetime !== "string" ||
    !Number.isFinite(parsedTime) ||
    parsedTime <= ALLOWED_NOW ||
    typeof room !== "string" ||
    room.trim().length === 0 ||
    typeof campus !== "string" ||
    campus.trim().length === 0 ||
    typeof mapLink !== "string" ||
    mapLink.trim().length === 0 ||
    typeof from !== "string" ||
    from.trim().length === 0 ||
    typeof to !== "string" ||
    to.trim().length === 0 ||
    typeof message !== "string" ||
    message.trim().length === 0
  ) {
    return record(request, "schedule", 422, ids, body);
  }
  interview = {
    ...interview,
    status: "pending",
    scheduled: datetime,
    room,
    campus,
    mapLink,
    responseCode: capability,
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
    (interview?.status !== "pending" && interview?.status !== "accepted")
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
  if (capabilityUsed || interview?.status !== "pending") {
    return record(request, "accept-candidate", 409);
  }
  interview = { ...interview, status: "accepted" };
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
      interview = { ...interview, status: body.state };
      return empty();
    case "unknown-interview":
      if (interview === null) return empty(409);
      interview = { ...interview, id: 999 };
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
  if (url.pathname === "/api/admin/interviews" && request.method === "GET") {
    return handleList(request);
  }

  const scheduleMatch = url.pathname.match(/^\/api\/admin\/interviews\/([^/]+)\/schedule$/);
  if (scheduleMatch !== null && request.method === "POST") {
    return handleSchedule(request, decodeURIComponent(scheduleMatch[1] ?? ""));
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

