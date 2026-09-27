[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Delete team application

Removes one application and its undelivered notifications. Only the current team leader can delete.

**DELETE /api/team-applications/{applicationId}**

Responses: 204, 400, 401, 403, 404, 409, 500, 503.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/team-applications.deleteTeamApplication) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
