import Ajv2020 from "ajv/dist/2020.js";
import acceptedIntentSchema from "../schemas/accepted-intent.json";
import acceptedIntentAuthoringSchema from "../schemas/accepted-intent-authoring.json";

export interface AcceptedIntentEnvelopeShape {
  readonly schema_version: "functional-parity-accepted-intent/v1";
  readonly intents: readonly unknown[];
  readonly journeys: readonly unknown[];
}

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
  readonly inventory_kinds: readonly string[];
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
    readonly surface: string;
    readonly row_ids: readonly string[];
    readonly canonical_signatures: readonly string[];
    readonly expected_contract_ref: string | null;
    readonly runtime_evidence_ref_ids: readonly string[];
  }[];
  readonly coverage_scope: string;
}

export const ACCEPTED_INTENT_SCHEMA = acceptedIntentSchema as Record<string, unknown>;
export const ACCEPTED_INTENT_AUTHORING_SCHEMA = acceptedIntentAuthoringSchema as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(ACCEPTED_INTENT_SCHEMA);
const acceptedIntentValidator = ajv.getSchema<AcceptedIntentEnvelopeShape>(
  "urn:vektorprogrammet:functional-parity-accepted-intent:v1",
);
if (acceptedIntentValidator === undefined)
  throw new Error("accepted intent schema did not compile");
const acceptedIntentAuthoringValidator = ajv.compile<AcceptedIntentAuthoringDocument>(
  ACCEPTED_INTENT_AUTHORING_SCHEMA,
);

export const validateAcceptedIntentShape = (value: unknown): value is AcceptedIntentEnvelopeShape =>
  acceptedIntentValidator(value) === true;

export const validateAcceptedIntentAuthoringShape = (
  value: unknown,
): value is AcceptedIntentAuthoringDocument => acceptedIntentAuthoringValidator(value) === true;
