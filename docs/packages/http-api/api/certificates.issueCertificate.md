[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Issue certificate

Records one issue of the certificate with the issuer, the authorizing seat, the instant, and the content hash, and returns the PDF. Requires the observed certificate entity tag. An idempotency-key replay returns the same PDF.

**POST /api/departments/{departmentId}/certificates/{personId}/issues**

Responses: 200, 400, 401, 403, 404, 409, 412, 422, 428, 500, 503.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/certificates.issueCertificate) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
