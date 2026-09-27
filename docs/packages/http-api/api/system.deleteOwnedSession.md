[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Revoke one session

Revokes one owned session; missing and non-owned identifiers are concealed.

**DELETE /api/sessions/{sessionId}**

Responses: 204, 400, 401, 403, 404, 409, 500, 503.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/system.deleteOwnedSession) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
