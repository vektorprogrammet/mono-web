# @vektorprogrammet/sdk

## 0.3.0

### Minor Changes

- 3d4b28e: Fail every declared problem response with a typed `Problem` from `@vektorprogrammet/http-api` instead of a `{ body, headers }` envelope. Read the code as `problem.code`, detect a problem with `isProblem`, and read the RFC 9457 body with `problemBody`. Secured operations declare `credential.missing` and `credential.invalid` once, through their security middleware.

### Patch Changes

- 287b161: Decode generated NativeApi response headers from Fetch-normalized lowercase header names.
  - @vektorprogrammet/http-api@0.3.0

## 0.1.2

### Patch Changes

- Add profilePhoto field to ProfileResource API types

## 0.1.1

### Patch Changes

- Add role field to ProfileResource API types
