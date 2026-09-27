[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Read certificate

Returns every semester of the assistant in the department with its status and the certificate that an issue would record. Issuers of the department only, never the assistant.

**GET /api/departments/{departmentId}/certificates/{personId}**

Responses: 200, 400, 401, 403, 404, 409, 500.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/certificates.readCertificate) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
