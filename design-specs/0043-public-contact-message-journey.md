# Design spec 0043: public contact-message journey

## Metadata

| Field      | Value                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| Goal       | Replace the legacy public contact-message journey with one native journey                 |
| Status     | Frozen                                                                                    |
| Actor      | Public visitor                                                                            |
| Dependency | Public department API, contact-message API, and typed SDK transport                       |
| Evidence   | Local Symfony API test and authorized remote browser run                                  |
| Scope hold | The operator must accept or replace the legacy reCAPTCHA disposition before Goal 1 closes |

## User journey

A visitor opens the contact page and selects an active department. The page shows live department contact details.

The visitor enters a name, email address, subject, and message. The visitor then sends the message once.

The backend stores no contact-message row. The backend sends one email to the selected department through its configured mail transport.

The page shows a success result after the API accepts the message. The form does not send the same message again.

## Goal

Complete one public contact-message journey on the native homepage. Use the existing Symfony API as the current effect authority.

## Constraints

1. The homepage must not use `DEV_CONTENT` for department contact data.
2. The department identifier must come from the live department response.
3. The SDK must decode the request before it sends JSON.
4. The SDK must model the `201` response as an empty success result.
5. The action must map typed API failures to public messages.
6. The page must not expose an email address for a different department.
7. The form must reject empty fields before it calls the API.
8. The server API remains the mail and rate-limit authority.
9. This slice must not add a second mail transport.
10. The route must preserve Norwegian user text.

## Values

1. Keep one department source for the contact details and submission target.
2. Keep one SDK operation for the contact-message command.
3. Keep validation at both trust boundaries.
4. Show a clear result for accepted and rejected commands.
5. Do not report delivery when the API rejects the command.

## Required behavior

### Department selection

The `/kontakt/:department` route selects the matching active department. The route returns `404` if no active department matches the path.

The active department route slugs must be non-empty and unique. The route returns `503` if the live data violates this invariant.
The `/kontakt` route selects the first active department from the API response. This default does not close the legacy geolocation parity gap.

The page shows the selected department name, email address, postal address, and city. Missing optional values remain absent.

### Contact command

The form sends these fields:

- `name`
- `email`
- `departmentId`
- `subject`
- `message`

The action gets `departmentId` from the selected route data. The action does not trust a hidden department field.

The SDK sends `POST /contact_messages` with `application/json`. The SDK returns an empty success result for HTTP `201`.

### Failure results

The form shows one Norwegian validation message for incomplete or malformed input. The browser keeps the draft after this result.
The action response contains no submitted values.

The form shows one rate-limit message for HTTP `429`. The form shows one general failure message for other API failures.

The form disables the send button while the request is active. A successful result clears the message fields.

### Anti-abuse disposition

The legacy form uses reCAPTCHA. The current API uses a five-per-hour address limit and rejects invalid JSON input.

This implementation keeps the current API rule. It does not classify the rule as accepted functional parity.

The zero-gap register must keep this difference open. An external accepted-intent record or a replacement challenge must close it.

## Definition of done

1. SDK tests prove input decoding, one JSON request, empty `201` success, and typed failure mapping.
2. A server test proves one valid command, one mail request, and invalid field rejection.
3. A browser journey selects a live department and sends one message.
4. The browser journey observes the selected department identifier in the API request.
5. The browser journey observes one success result and one rejected result.
6. The page contains no `DEV_CONTENT` contact data.
7. Root type checks, lint, build, and tests pass on the committed revision.
8. The browser evidence names the unresolved anti-abuse disposition.
9. The browser runner rejects local execution before it starts a child process.

## Falsifiers

This contract is false if one condition occurs:

- The form submits a department identifier from browser-controlled form data.
- The page shows details from a synthetic department source.
- A `201` response fails because it has no JSON body.
- The page reports success after an API rejection.
- One click sends more than one request.
- A stale route selects a different active department.
- Two active departments map to the same route slug.
- The implementation claims that the rate limit equals legacy reCAPTCHA behavior.
