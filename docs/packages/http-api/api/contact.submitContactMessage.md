[//]: # "generated from packages/http-api/openapi.json by just docs generate; do not edit"

# Send public contact message

Consumes one of five attempts per visitor fixed one-hour window and waits for delivery transport acceptance. No message is persisted; no automatic retry. HTTP 201 has no body and is not proof of inbox delivery.

**POST /api/contact-messages**

Responses: 201, 400, 401, 413, 415, 422, 429, 500, 503.

[Request and response schemas](https://vektorprogrammet.github.io/mono-web/docs/packages/http-api/api/contact.submitContactMessage) are rendered from the public OpenAPI contract.

[Contract source](../../../../packages/http-api/src/api.ts)
