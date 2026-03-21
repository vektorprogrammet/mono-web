/**
 * IRI reference -> numeric ID extraction.
 * API Platform returns "/api/users/42" -- we extract 42.
 */

export function parseIri(iri: string): number {
  const match = iri.match(/\/(\d+)$/)
  if (!match) throw new Error(`Invalid IRI: ${iri}`)
  return Number(match[1])
}

export function parseOptionalIri(iri: string | null): number | null {
  return iri === null ? null : parseIri(iri)
}
