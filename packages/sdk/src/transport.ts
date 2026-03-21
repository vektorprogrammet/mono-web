/**
 * Transport layer — wraps fetch with auth resolution and error mapping.
 *
 * All request helpers return Effect<A, InternalSdkError> where A is decoded via Schema.
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
const mapStatusToError = (status: number, _body: unknown): InternalSdkError => {
  if (status === 401 || status === 403) return new Unauthorized({ message: `HTTP ${status}` })
  if (status === 404) return new NotFound({ message: "Not found" })
  if (status === 409) return new Conflict({ message: "Conflict" })
  if (status === 422) return new Validation({ message: "Validation failed", fields: {} })
  if (status === 429) return new RateLimited({ message: "Rate limited" })
  return new Network({ message: `HTTP ${status}` })
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
 * Creates a Transport backed by fetch.
 *
 * Auth is injected into every request as a Bearer token header.
 * Responses are decoded through the provided Schema.
 * HTTP errors are mapped to InternalSdkError.
 */
export function createTransport(baseUrl: string, auth?: AuthOption): Transport {
  const buildHeaders = (
    extra?: Record<string, string>,
  ): Effect.Effect<Record<string, string>> => {
    const headers: Record<string, string> = { ...extra }
    if (!auth) return Effect.succeed(headers)
    return pipe(
      resolveAuth(auth),
      Effect.map((token) => {
        headers["Authorization"] = `Bearer ${token}`
        return headers
      }),
    )
  }

  const buildUrl = (path: string, params?: Record<string, string | number | undefined>): string => {
    const url = new URL(path, baseUrl)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  const executeFetch = (
    url: string,
    init: RequestInit,
  ): Effect.Effect<Response, InternalSdkError> =>
    Effect.tryPromise({
      try: () => fetch(url, init),
      catch: (cause) => new Network({ message: cause instanceof Error ? cause.message : "Network error" }),
    })

  const executeJson = (
    url: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Effect.Effect<unknown, InternalSdkError> =>
    pipe(
      buildHeaders({
        "Accept": "application/ld+json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      }),
      Effect.flatMap((headers) =>
        executeFetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
      Effect.flatMap((response) => {
        if (!response.ok) {
          return pipe(
            Effect.tryPromise({
              try: () => response.json(),
              catch: () => null as unknown,
            }),
            Effect.orElseSucceed(() => null as unknown),
            Effect.flatMap((responseBody) =>
              Effect.fail(mapStatusToError(response.status, responseBody)),
            ),
          )
        }
        return Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new Network({ message: "Failed to parse response JSON" }),
        })
      }),
    )

  const executeVoid = (
    url: string,
    method: string,
    body?: unknown,
  ): Effect.Effect<void, InternalSdkError> =>
    pipe(
      buildHeaders(
        body !== undefined ? { "Content-Type": "application/json" } : {},
      ),
      Effect.flatMap((headers) =>
        executeFetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
      Effect.flatMap((response) => {
        if (!response.ok) {
          return pipe(
            Effect.tryPromise({
              try: () => response.json(),
              catch: () => null as unknown,
            }),
            Effect.orElseSucceed(() => null as unknown),
            Effect.flatMap((responseBody) =>
              Effect.fail(mapStatusToError(response.status, responseBody)),
            ),
          )
        }
        return Effect.void
      }),
    )

  const decodeWith = <A, I>(schema: Schema.Schema<A, I>) =>
    (json: unknown): Effect.Effect<A, InternalSdkError> =>
      Schema.decodeUnknown(schema)(json).pipe(
        Effect.mapError((e) => new Validation({ message: `Decode error: ${e.message}`, fields: {} })),
      )

  return {
    get<A, I>(url: string, schema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      return pipe(
        executeJson(buildUrl(url, params), "GET"),
        Effect.flatMap(decodeWith(schema)),
      )
    },

    getCollection<A, I>(url: string, itemSchema: Schema.Schema<A, I>, params?: Record<string, string | number | undefined>) {
      return pipe(
        executeJson(buildUrl(url, params), "GET"),
        Effect.flatMap((json: unknown) => {
          const obj = json as Record<string, unknown>
          const members: unknown[] = (obj?.["hydra:member"] as unknown[]) ?? []
          const totalItems: number = (obj?.["hydra:totalItems"] as number) ?? 0
          return pipe(
            Effect.forEach(members, decodeWith(itemSchema)),
            Effect.map((items) => ({ items, totalItems })),
          )
        }),
      )
    },

    post<A, I>(url: string, body: unknown, schema: Schema.Schema<A, I>) {
      return pipe(
        executeJson(buildUrl(url), "POST", body),
        Effect.flatMap(decodeWith(schema)),
      )
    },

    postVoid(url: string, body: unknown) {
      return executeVoid(buildUrl(url), "POST", body)
    },

    put(url: string, body: unknown) {
      return executeVoid(buildUrl(url), "PUT", body)
    },

    del(url: string) {
      return executeVoid(buildUrl(url), "DELETE")
    },

    postFormData<A, I>(url: string, formData: FormData, schema: Schema.Schema<A, I>) {
      return pipe(
        buildHeaders({ "Accept": "application/ld+json" }),
        Effect.flatMap((headers) =>
          executeFetch(buildUrl(url), {
            method: "POST",
            headers,
            body: formData,
          }),
        ),
        Effect.flatMap((response) => {
          if (!response.ok) {
            return pipe(
              Effect.tryPromise({
                try: () => response.json(),
                catch: () => new Network({ message: "Failed to parse error response" }),
              }),
              Effect.flatMap((responseBody) =>
                Effect.fail(mapStatusToError(response.status, responseBody)),
              ),
            )
          }
          return Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () => new Network({ message: "Failed to parse response JSON" }),
          })
        }),
        Effect.flatMap(decodeWith(schema)),
      )
    },

    postFormDataVoid(url: string, formData: FormData) {
      return pipe(
        buildHeaders(),
        Effect.flatMap((headers) =>
          executeFetch(buildUrl(url), {
            method: "POST",
            headers,
            body: formData,
          }),
        ),
        Effect.flatMap((response) => {
          if (!response.ok) {
            return pipe(
              Effect.tryPromise({
                try: () => response.json(),
                catch: () => new Network({ message: "Failed to parse error response" }),
              }),
              Effect.flatMap((responseBody) =>
                Effect.fail(mapStatusToError(response.status, responseBody)),
              ),
            )
          }
          return Effect.void
        }),
      )
    },
  }
}
