[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# List days served

Returns a bounded page of the assistants of a department and semester with the dated evidence, the calculated count, and the current confirmation. Requires the days-served capability in the department.

**GET /api/departments/{departmentId}/semesters/{semesterId}/days-served**

Responses: 200, 400, 401, 403, 404, 409, 500.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/certificates.listDaysServed) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
