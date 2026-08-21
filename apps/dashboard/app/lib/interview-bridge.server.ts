import {
  InterviewId,
  InterviewScheduleInput,
  ResponseCapability,
  type Sdk,
} from "@vektorprogrammet/sdk"
import { Schema } from "effect"
import { createAuthenticatedClient, createServerClient } from "./api.server"

const CandidateCookie = "foldkit_candidate"
const ControlHeader = "X-Interview-Fixture-Control"

const Operation = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("listInterviews") }),
  Schema.Struct({ operation: Schema.Literal("readInterview"), interviewId: InterviewId }),
  Schema.Struct({
    operation: Schema.Literal("scheduleInterview"),
    interviewId: InterviewId,
    input: InterviewScheduleInput,
  }),
  Schema.Struct({ operation: Schema.Literal("readCandidate") }),
  Schema.Struct({ operation: Schema.Literal("confirmCandidate") }),
  Schema.Struct({ operation: Schema.Literal("rejectCandidate"), message: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("requestNewTimeCandidate"), message: Schema.String }),
])

type Operation = typeof Operation.Type

export const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const

const fixtureControlKey = (): string => {
  const key = process.env.INTERVIEW_FIXTURE_CONTROL_KEY?.trim() ?? ""
  if (key.length < 32) throw new Error("INTERVIEW_FIXTURE_CONTROL_KEY is required")
  return key
}

export const fixtureControlHeaders = (): HeadersInit =>
  process.env.API_MODE === "fixture"
    ? { [ControlHeader]: fixtureControlKey() }
    : {}

export const ownerEnabled = (): boolean =>
  process.env.DASHBOARD_INTERVIEW_OWNER === "foldkit"

const candidateCapability = (request: Request): string | null => {
  const cookie = request.headers.get("cookie") ?? ""
  const encoded = cookie.match(new RegExp(`(?:^|;\\s*)${CandidateCookie}=([^;]*)`))?.[1]
  if (encoded === undefined) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export const createCandidateCookie = (capability: string): string => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
  return `${CandidateCookie}=${encodeURIComponent(capability)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${secure}`
}

const sdkFor = (request: Request): Sdk => {
  const cookie = request.headers.get("cookie") ?? ""
  const encoded =
    cookie.match(/(?:^|;\s*)jwt_token=([^;]*)/)?.[1] ??
    (process.env.API_MODE === "fixture"
      ? cookie.match(/(?:^|;\s*)fixture_session=([^;]*)/)?.[1]
      : undefined)
  if (encoded === undefined) throw Object.assign(new Error("Unauthorized"), { type: "unauthorized" })
  return createAuthenticatedClient(decodeURIComponent(encoded))
}

const candidateSdk = (): Sdk =>
  process.env.API_MODE === "fixture"
    ? createAuthenticatedClient(fixtureControlKey())
    : createServerClient()

export const readCandidateCapability = async (capability: string): Promise<unknown> =>
  candidateSdk().interviewResponses.read(
    Schema.decodeUnknownSync(ResponseCapability)(capability),
  )

export const decodeOperation = (value: unknown): Operation =>
  Schema.decodeUnknownSync(Operation)(value)

export const runOperation = async (request: Request, operation: Operation): Promise<unknown> => {
  switch (operation.operation) {
    case "listInterviews":
      return sdkFor(request).admin.interviews.list()
    case "readInterview":
      return sdkFor(request).admin.interviews.read(operation.interviewId)
    case "scheduleInterview":
      await sdkFor(request).admin.interviews.schedule(operation.interviewId, operation.input)
      return null
    case "readCandidate": {
      const capability = Schema.decodeUnknownSync(ResponseCapability)(candidateCapability(request))
      return candidateSdk().interviewResponses.read(capability)
    }
    case "confirmCandidate": {
      const capability = Schema.decodeUnknownSync(ResponseCapability)(candidateCapability(request))
      await candidateSdk().interviewResponses.confirm(capability)
      return null
    }
    case "rejectCandidate": {
      const capability = Schema.decodeUnknownSync(ResponseCapability)(candidateCapability(request))
      await candidateSdk().interviewResponses.reject(capability, operation.message)
      return null
    }
    case "requestNewTimeCandidate": {
      const capability = Schema.decodeUnknownSync(ResponseCapability)(candidateCapability(request))
      await candidateSdk().interviewResponses.requestNewTime(capability, operation.message)
      return null
    }
  }
}
