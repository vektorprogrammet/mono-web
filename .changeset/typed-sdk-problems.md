---
"@vektorprogrammet/sdk": minor
---

Fail every declared problem response with a typed `Problem` from `@vektorprogrammet/http-api` instead of a `{ body, headers }` envelope. Read the code as `problem.code`, detect a problem with `isProblem`, and read the RFC 9457 body with `problemBody`. Secured operations declare `credential.missing` and `credential.invalid` once, through their security middleware.
