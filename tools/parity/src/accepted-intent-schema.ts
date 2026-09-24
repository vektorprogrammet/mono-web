import Ajv2020 from "ajv/dist/2020.js";
import acceptedIntentSchema from "../schemas/accepted-intent.json";
import acceptedIntentAuthoringSchema from "../schemas/accepted-intent-authoring.json";

import type { AcceptedIntentRegister } from "./coverage.js";
import type { InventoryKind } from "./types.js";

export interface AcceptedIntentAuthoringDocument {
  readonly schema_version: "functional-parity-accepted-intent-authoring/v1";
  readonly selected_revision_ref_ids: readonly string[];
  readonly intents: readonly AcceptedIntentAuthoringRecord[];
  readonly journeys: readonly AcceptedJourneyAuthoringRecord[];
}

export interface AcceptedIntentAuthoringRecord {
  readonly intent_ref_id: string;
  readonly intent_revision: string;
  readonly source_ref_ids: readonly string[];
  readonly purpose: "coverage" | "disposition";
  readonly disposition: string | null;
  readonly row_ids: readonly string[];
  readonly canonical_signatures: readonly string[];
  readonly inventory_kinds: readonly InventoryKind[];
  readonly journey_ref_ids: readonly string[];
}

export interface AcceptedJourneyAuthoringRecord {
  readonly journey_ref_id: string;
  readonly journey_key: string;
  readonly intent_ref_id: string;
  readonly journey_revision: string;
  readonly source_ref_ids: readonly string[];
  readonly steps: readonly {
    readonly step_id: string;
    readonly surface: InventoryKind;
    readonly row_ids: readonly string[];
    readonly canonical_signatures: readonly string[];
    readonly expected_contract_ref: string | null;
    readonly runtime_evidence_ref_ids: readonly string[];
  }[];
  readonly coverage_scope: string;
}

export const ACCEPTED_INTENT_SCHEMA = acceptedIntentSchema;

export const ACCEPTED_INTENT_AUTHORING_SCHEMA = acceptedIntentAuthoringSchema;

const ajv = new Ajv2020({ allErrors: true, strict: false });

ajv.addSchema(ACCEPTED_INTENT_SCHEMA);

const acceptedIntentValidator = ajv.getSchema<AcceptedIntentRegister>(
  "urn:vektorprogrammet:functional-parity-accepted-intent:v1",
);

if (acceptedIntentValidator === undefined)
  throw new Error("accepted intent schema did not compile");

const acceptedIntentAuthoringValidator = ajv.compile<AcceptedIntentAuthoringDocument>(
  ACCEPTED_INTENT_AUTHORING_SCHEMA,
);

export const validateAcceptedIntentRegister = (value: unknown): value is AcceptedIntentRegister =>
  acceptedIntentValidator(value) === true;

export const validateAcceptedIntentAuthoringDocument = (
  value: unknown,
): value is AcceptedIntentAuthoringDocument => acceptedIntentAuthoringValidator(value) === true;
