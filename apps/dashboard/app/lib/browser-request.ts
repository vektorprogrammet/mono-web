/** Browser bridge requests must carry the executing Effect's cancellation signal. */
export type AbortableRequestInit = RequestInit & { readonly signal: AbortSignal };
