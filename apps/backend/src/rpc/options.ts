/**
 * The options that the composition root passes to every context's RPC handlers. One shape for
 * every context keeps the router a list, and lets each context read only what it needs.
 */
import type { BackendConfig } from "../config.js";
import type { ReceiptFileStore } from "../receipt/filesystem.js";
import type { SocialEventTransactionHook } from "../social-events/rpc.js";

export interface NativeRpcOptions {
  readonly config: BackendConfig;
  /** Evidence compositions can pin one authorization instant without patching the global clock. */
  readonly now?: () => string;
  /** Test-only social-event transaction coordination for real concurrent snapshot evidence. */
  readonly socialEventsTransactionHook?: SocialEventTransactionHook;
  /** Selects the composition-owned private receipt store; Bun keeps its filesystem default. */
  readonly receiptFileStore?: ReceiptFileStore;
}
