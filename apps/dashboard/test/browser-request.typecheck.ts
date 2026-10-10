import type { AbortableRequestInit } from "../app/lib/browser-request";

type RequireAbortableRequest<Init extends AbortableRequestInit> = Init;

export type ValidRequest = RequireAbortableRequest<{
  readonly method: "POST";
  readonly signal: AbortSignal;
}>;

// @ts-expect-error A bridge request without a signal is not cancellable.
export type MissingSignal = RequireAbortableRequest<{ readonly method: "POST" }>;

// @ts-expect-error RequestInit's nullable signal must not cross the bridge boundary.
export type NullSignal = RequireAbortableRequest<{ readonly signal: null }>;

// @ts-expect-error An optional signal permits a non-cancellable request.
export type OptionalSignal = RequireAbortableRequest<{ readonly signal?: AbortSignal }>;
