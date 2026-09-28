import type {
  Binding,
  Persons,
  ReimbursementFacts,
} from "../../../tools/e2e/golden-reimbursement-evidence";

/** One observation of the browser journey, such as a denial, a session, or a bound. */
export interface ReimbursementBrowserCheck {
  readonly kind: string;
}

export interface ReimbursementBrowserEvidence {
  readonly passed: true;
  readonly receiptId: string;
  readonly settlementId: string;
  readonly checks: ReadonlyArray<ReimbursementBrowserCheck>;
}

/** The runner hooks that the browser journey calls back into. */
export interface ReimbursementBrowserHooks {
  readonly origins: { readonly backend: string; readonly dashboard: string };
  readonly persons: Persons;
  readonly artifacts: string;
  readonly checkpoint: (step: string, binding?: Binding) => Promise<ReimbursementFacts>;
  readonly eventually: (
    label: string,
    inspect: () => Promise<boolean>,
    timeout?: number,
  ) => Promise<void>;
  readonly readFacts: () => Promise<ReimbursementFacts>;
  readonly restart: (mode?: string) => Promise<void>;
  readonly providerMode: (mode: string) => void;
  readonly fault: string | undefined;
  readonly browserReady: (browser: { close: () => Promise<void> }) => void;
}

export declare const runReimbursementBrowser: (
  hooks: ReimbursementBrowserHooks,
) => Promise<ReimbursementBrowserEvidence>;
