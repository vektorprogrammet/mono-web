import {
  RecruitmentInvitationCapabilitySchema,
  type Sdk,
} from "@vektorprogrammet/sdk"
import { Schema as S } from "effect"
import {
  InvitationBridgeOperationSchema,
  type InvitationBridgeFailure,
  type InvitationBridgeOperation,
} from "../foldkit/interview/bridge"
import { createServerClient } from "./api.server"

const InvitationCapabilityCookie = "recruitment_invitation_capability"
const MaximumBridgeBodyBytes = 4_096
const SecureCookieAttribute = process.env.NODE_ENV === "production" ? "; Secure" : ""

export const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const

export const ownerEnabled = (): boolean =>
  process.env.DASHBOARD_INTERVIEW_OWNER === "foldkit"


const invitationCapability = (
  request: Request,
): typeof RecruitmentInvitationCapabilitySchema.Type => {
  const cookie = request.headers.get("cookie") ?? ""
  const encoded = cookie.match(
    new RegExp(`(?:^|;\\s*)${InvitationCapabilityCookie}=([^;]*)`),
  )?.[1]
  if (encoded === undefined) {
    throw {
      _tag: "InvitationNotFound",
      message: "Invitation capability unavailable",
    } satisfies InvitationBridgeFailure
  }
  try {
    return S.decodeUnknownSync(RecruitmentInvitationCapabilitySchema)(
      decodeURIComponent(encoded),
    )
  } catch {
    throw {
      _tag: "InvitationNotFound",
      message: "Invitation capability unavailable",
    } satisfies InvitationBridgeFailure
  }
}

export const createInvitationCapabilityCookie = (capability: string): string =>
  `${InvitationCapabilityCookie}=${encodeURIComponent(capability)}; Path=/; HttpOnly; SameSite=Strict${SecureCookieAttribute}`

export const clearInvitationCapabilityCookie = (): string =>
  `${InvitationCapabilityCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${SecureCookieAttribute}`

const decodeExchangeCapability = (
  capability: unknown,
): typeof RecruitmentInvitationCapabilitySchema.Type =>
  S.decodeUnknownSync(RecruitmentInvitationCapabilitySchema)(capability, {
    onExcessProperty: "error",
  })

export const readInvitationCapability = async (capability: string): Promise<unknown> =>
  createServerClient().recruitmentInvitationResponses.read(
    decodeExchangeCapability(capability),
  )

export const decodeOperation = (value: unknown): InvitationBridgeOperation => {
  try {
    const operation = S.decodeUnknownSync(InvitationBridgeOperationSchema)(value, {
      onExcessProperty: "error",
    })
    if (operation.operation !== "rejectInvitation") return operation
    const message = operation.message?.trim() ?? null
    if (message !== null && message.length > 2_000) {
      throw new Error("Rejected invitation message exceeds its boundary")
    }
    return {
      ...operation,
      message: message === "" ? null : message,
    }
  } catch {
    throw {
      _tag: "InvitationDecodeError",
      message: "Invalid invitation response operation",
    } satisfies InvitationBridgeFailure
  }
}

export const decodeOperationRequest = async (
  request: Request,
): Promise<InvitationBridgeOperation> => {
  const url = new URL(request.url)
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim()
  if (
    request.method !== "POST" ||
    url.search !== "" ||
    contentType !== "application/json"
  ) {
    throw {
      _tag: "InvitationDecodeError",
      message: "Invalid invitation response request",
    } satisfies InvitationBridgeFailure
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MaximumBridgeBodyBytes) {
    throw {
      _tag: "InvitationDecodeError",
      message: "Invalid invitation response request",
    } satisfies InvitationBridgeFailure
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    )
    return decodeOperation(value)
  } catch {
    throw {
      _tag: "InvitationDecodeError",
      message: "Invalid invitation response request",
    } satisfies InvitationBridgeFailure
  }
}

export const runOperation = async (
  request: Request,
  operation: InvitationBridgeOperation,
): Promise<unknown> => {
  const capability = invitationCapability(request)
  const client: Sdk = createServerClient()
  switch (operation.operation) {
    case "readInvitationResponse":
      return client.recruitmentInvitationResponses.read(capability)
    case "confirmInvitation":
      await client.recruitmentInvitationResponses.confirm(capability)
      return undefined
    case "rejectInvitation":
      if (operation.message === null) {
        await client.recruitmentInvitationResponses.reject(capability)
      } else {
        await client.recruitmentInvitationResponses.reject(capability, {
          message: operation.message,
        })
      }
      return undefined
    case "requestNewInvitationTime":
      await client.recruitmentInvitationResponses.requestNewTime(capability, {
        message: operation.message,
      })
      return undefined
  }
}

const safeFailure = (
  tag: InvitationBridgeFailure["_tag"],
  message: string,
): InvitationBridgeFailure => ({ _tag: tag, message })

export const bridgeFailureFrom = (error: unknown): InvitationBridgeFailure => {
  const tag = typeof error === "object" && error !== null
    ? "recruitmentTag" in error && typeof error.recruitmentTag === "string"
      ? error.recruitmentTag
      : "_tag" in error && typeof error._tag === "string"
        ? error._tag
        : "type" in error && typeof error.type === "string"
          ? error.type
          : undefined
    : undefined
  switch (tag) {
    case "InvitationNotFound":
    case "RecruitmentInvitationNotFound":
    case "not_found":
      return safeFailure("InvitationNotFound", "Invitation unavailable")
    case "RecruitmentInvitationAlreadyResponded":
    case "InvitationAlreadyResponded":
    case "conflict":
      return safeFailure("InvitationAlreadyResponded", "Invitation already responded")
    case "RecruitmentDecodeError":
    case "InvitationDecodeError":
    case "validation":
      return safeFailure("InvitationDecodeError", "Invitation response input invalid")
    case "RecruitmentPersistenceError":
    case "InvitationUnavailable":
    case "network":
    case "configuration":
      return safeFailure("InvitationUnavailable", "Invitation response unavailable")
    default:
      return safeFailure("InvitationUnavailable", "Invitation response unavailable")
  }
}

export const statusForInvitationFailure = (failure: InvitationBridgeFailure): number => {
  switch (failure._tag) {
    case "InvitationNotFound":
      return 404
    case "InvitationAlreadyResponded":
      return 409
    case "InvitationDecodeError":
      return 422
    case "InvitationUnavailable":
      return 503
  }
}
