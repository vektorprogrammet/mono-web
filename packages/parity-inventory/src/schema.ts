import Ajv2020 from "ajv/dist/2020.js"
import inventorySchema from "../schemas/inventory.json"
import sourceManifestSchema from "../schemas/source-manifest.json"
import reportSchema from "../schemas/report.json"
import openapiReconciliationSchema from "../schemas/openapi-reconciliation.json"
import type { InventoryEnvelope, OpenApiReconciliation, SourceManifest, ZeroGapReport } from "./types.js"

export const INVENTORY_SCHEMA = inventorySchema as Record<string, unknown>
export const SOURCE_MANIFEST_SCHEMA = sourceManifestSchema as Record<string, unknown>
export const REPORT_SCHEMA = reportSchema as Record<string, unknown>
export const OPENAPI_RECONCILIATION_SCHEMA = openapiReconciliationSchema as Record<string, unknown>

const ajv = new Ajv2020({ allErrors: true, strict: false })
const inventoryValidator = ajv.compile<InventoryEnvelope>(INVENTORY_SCHEMA)
const sourceManifestValidator = ajv.compile<SourceManifest>(SOURCE_MANIFEST_SCHEMA)
const reportValidator = ajv.compile<ZeroGapReport>(REPORT_SCHEMA)
const openapiReconciliationValidator = ajv.compile<OpenApiReconciliation>(OPENAPI_RECONCILIATION_SCHEMA)

export const validateInventory = (value: unknown): value is InventoryEnvelope => inventoryValidator(value) === true

export const validateSourceManifest = (value: unknown): value is SourceManifest => sourceManifestValidator(value) === true

export const validateOpenApiReconciliation = (value: unknown): value is OpenApiReconciliation => openapiReconciliationValidator(value) === true

export const validateReport = (value: unknown): value is ZeroGapReport => reportValidator(value) === true

export const validateArtifacts = (manifest: unknown, legacy: unknown, mono: unknown, api: unknown, reconciliation: unknown, report: unknown): boolean =>
  validateSourceManifest(manifest) && validateInventory(legacy) && validateInventory(mono) && validateInventory(api) && validateOpenApiReconciliation(reconciliation) && validateReport(report)
