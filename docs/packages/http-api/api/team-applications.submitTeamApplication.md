[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Submit team application

Stores one application to an open team and queues its receipt and team notification. An idempotency-key replay returns the original result. Every submission, including a replay, counts against one public rate limit.

**POST /api/teams/{teamId}/applications**

Responses: 201, 400, 404, 409, 413, 415, 422, 429, 500, 503.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/team-applications.submitTeamApplication) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
