/**
 * API Platform violation list -> ValidationError fields mapping.
 *
 * API Platform returns:
 * { "violations": [{ "propertyPath": "description", "message": "This value is too short." }] }
 */

export function parseViolations(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {}
  const violations = (body as Record<string, unknown>)["violations"]
  if (!Array.isArray(violations)) return {}

  const fields: Record<string, string> = {}
  for (const v of violations) {
    if (typeof v?.propertyPath === "string" && typeof v?.message === "string") {
      fields[v.propertyPath] = v.message
    }
  }
  return fields
}
