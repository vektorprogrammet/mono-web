[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Claim applicant account invitation

The body token is required in both modes and works once. In new-account mode the token is the one credential, so a session cookie or bearer beside it is rejected. In existing-account mode the browser session names the one principal, and the token is its requirement onboarding.claim-token: it must name an open invitation. A delegated bearer cannot make the claim.

**POST /api/onboarding/claim**

Responses: 200, 400, 401, 403, 404, 409, 412, 413, 415, 422, 428, 500.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/onboarding.claim) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
