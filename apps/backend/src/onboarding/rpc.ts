/**
 * The OnboardingRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/onboarding/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { OnboardingRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const OnboardingRpcHandlers = (_options: NativeRpcOptions) => OnboardingRpcs.toLayer({});
