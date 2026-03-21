/**
 * Transport layer — wraps native fetch with auth and error mapping.
 *
 * All request helpers return Effect<A, InternalSdkError>.
 * The caller provides the Schema; the transport handles HTTP, auth, and error mapping.
 */

import { Effect, Schema, pipe } from "effect"
import {
  Unauthorized, NotFound, Validation, Conflict, Network, RateLimited,
  type InternalSdkError,
} from "./errors.js"

export type AuthOption = string | (() => string | Promise<string>)

/**
 * Resolves the auth token — supports static string or async function.
 */
const resolveAuth = (auth: AuthOption): Effect.Effect<string> =>
  typeof auth === "string"
    ? Effect.succeed(auth)
    : Effect.promise(async () => {
        const result = auth()
        return result instanceof Promise ? result : result
      })

/**
 * Maps HTTP status codes to InternalSdkError.
 */
const mapStatus = (status: number, message: string): InternalSdkError => {
  if (status === 401 || status === 403) return new Unauthorized({ message: `HTTP ${status}` })
  if (status === 404) return new NotFound({ message })
  if (status === 409) return new Conflict({ message })
  if (status === 422) return new Validation({ message, fields: {} })
  if (status === 429) return new RateLimited({ message: "Rate limited" })
  return new Network({ message: `HTTP ${status}: ${message}` })
}

export interface Transport {
  get<A, I>(url: string, schema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>): Effect.Effect<A, InternalSdkError>
  getCollection<A, I>(url: string, itemSchema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>): Effect.Effect<{ items: A[], totalItems: number }, InternalSdkError>
  post<A, I>(url: string, body: unknown, schema: Schema.Schema<A, I>): Effect.Effect<A, InternalSdkError>
  postVoid(url: string, body: unknown): Effect.Effect<void, InternalSdkError>
  put(url: string, body: unknown): Effect.Effect<void, InternalSdkError>
  del(url: string): Effect.Effect<void, InternalSdkError>
  postFormData<A, I>(url: string, formData: FormData, schema: Schema.Schema<A, I>): Effect.Effect<A, InternalSdkError>
  postFormDataVoid(url: string, formData: FormData): Effect.Effect<void, InternalSdkError>
}

/**
 * Creates a Transport backed by native fetch.
 */
export function createTransport(baseUrl: string, auth?: AuthOption): Transport {
  const buildUrl = (path: string, params?: Record<string, string | number | undefined>): string => {
    const url = new URL(path, baseUrl + "/")
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  const buildHeaders = (auth?: AuthOption): Effect.Effect<Record<string, string>> => {
    const base: Record<string, string> = { "Content-Type": "application/json" }
    if (!auth) return Effect.succeed(base)
    return pipe(
      resolveAuth(auth),
      Effect.map((token) => ({ ...base, Authorization: `Bearer ${token}` })),
    )
  }

  const executeJson = (method: string, url: string, body?: unknown): Effect.Effect<unknown, InternalSdkError> =>
    pipe(
      buildHeaders(auth),
      Effect.flatMap((headers) =>
        Effect.tryPromise({
          try: async () => {
            const init: RequestInit = { method, headers }
            if (body !== undefined) {
              init.body = JSON.stringify(body)
            }
            const res = await fetch(url, init)
            if (!res.ok) {
              const text = await res.text().catch(() => "")
              throw { status: res.status, message: text }
            }
            const text = await res.text()
            return text ? JSON.parse(text) : null
          },
          catch: (e: unknown) => {
            if (typeof e === "object" && e !== null && "status" in e) {
              const err = e as { status: number; message: string }
              return mapStatus(err.status, err.message)
            }
            return new Network({ message: String(e) })
          },
        }),
      ),
    )

  const executeFormData = (method: string, url: string, formData: FormData): Effect.Effect<unknown, InternalSdkError> =>
    pipe(
      auth ? resolveAuth(auth) : Effect.succeed(undefined as string | undefined),
      Effect.flatMap((token) =>
        Effect.tryPromise({
          try: async () => {
            const headers: Record<string, string> = {}
            if (token) headers["Authorization"] = `Bearer ${token}`
            const res = await fetch(url, { method, headers, body: formData })
            if (!res.ok) {
              const text = await res.text().catch(() => "")
              throw { status: res.status, message: text }
            }
            const text = await res.text()
            return text ? JSON.parse(text) : null
          },
          catch: (e: unknown) => {
            if (typeof e === "object" && e !== null && "status" in e) {
              const err = e as { status: number; message: string }
              return mapStatus(err.status, err.message)
            }
            return new Network({ message: String(e) })
          },
        }),
      ),
    )

  const executeVoid = (method: string, url: string, body?: unknown): Effect.Effect<void, InternalSdkError> =>
    pipe(
      buildHeaders(auth),
      Effect.flatMap((headers) =>
        Effect.tryPromise({
          try: async () => {
            const init: RequestInit = { method, headers }
            if (body !== undefined) {
              init.body = JSON.stringify(body)
            }
            const res = await fetch(url, init)
            if (!res.ok) {
              const text = await res.text().catch(() => "")
              throw { status: res.status, message: text }
            }
          },
          catch: (e: unknown) => {
            if (typeof e === "object" && e !== null && "status" in e) {
              const err = e as { status: number; message: string }
              return mapStatus(err.status, err.message)
            }
            return new Network({ message: String(e) })
          },
        }),
      ),
    )

  return {
    get<A, I>(url: string, schema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      return pipe(
        executeJson("GET", buildUrl(url, params)),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    getCollection<A, I>(url: string, itemSchema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      return pipe(
        executeJson("GET", buildUrl(url, params)),
        Effect.flatMap((json) => {
          const raw = json as Record<string, unknown>
          const members: unknown[] = Array.isArray(raw?.["hydra:member"]) ? (raw["hydra:member"] as unknown[]) : (Array.isArray(json) ? (json as unknown[]) : [])
          const totalItems: number = typeof raw?.["hydra:totalItems"] === "number" ? raw["hydra:totalItems"] as number : members.length
          return pipe(
            Effect.forEach(members, (item) =>
              Schema.decodeUnknown(itemSchema)(item).pipe(
                Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
              ),
            ),
            Effect.map((items) => ({ items, totalItems })),
          )
        }),
      )
    },

    post<A, I>(url: string, body: unknown, schema: Schema.Schema<A, I>) {
      return pipe(
        executeJson("POST", buildUrl(url), body),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    postVoid(url: string, body: unknown) {
      return executeVoid("POST", buildUrl(url), body)
    },

    put(url: string, body: unknown) {
      return executeVoid("PUT", buildUrl(url), body)
    },

    del(url: string) {
      return executeVoid("DELETE", buildUrl(url))
    },

    postFormData<A, I>(url: string, formData: FormData, schema: Schema.Schema<A, I>) {
      return pipe(
        executeFormData("POST", buildUrl(url), formData),
        Effect.flatMap((json) =>
          Schema.decodeUnknown(schema)(json).pipe(
            Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
          ),
        ),
      )
    },

    postFormDataVoid(url: string, formData: FormData) {
      return pipe(
        executeFormData("POST", buildUrl(url), formData),
        Effect.asVoid,
      )
    },
  }
}
