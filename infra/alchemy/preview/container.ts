import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Typed identifier for the one container-backed Durable Object used by p20.
 * The implementation is the immutable Symfony+MariaDB image declared by the
 * stack; this class intentionally carries no relational state of its own.
 */
export class PreviewContainer extends Cloudflare.Container<PreviewContainer>()(
  "PreviewContainer",
) {}
