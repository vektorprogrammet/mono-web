# Design spec 0053 - native Profile self-edit

## Metadata

| Field | Value |
|---|---|
| Status | Frozen before implementation |
| Base | `9c73f10e4eb41477b3efb5e0e3334deb2ec2926b` (`9c73f10`) |
| Goal | Give an authenticated member one native path to read and edit the member profile |
| Actor | Authenticated active member |
| Browser route | `/dashboard/profile/rediger` |
| HTTP routes | `GET /api/me`, `PUT /api/me` |
| Architecture | Design specs 0040 and 0045. Profile owns names and contact data. Identity owns credentials, sessions, and roles. |
| Operator boundary | No production data, remote PostgreSQL, provider, credential, deployment, or external notification effect |

## Problem

The profile-edit page has no warranted data path. The loader reads field-of-study data without authentication. The page always renders `getProfileData()` fixture values.

The submit handler discards all form values. It only opens `/dashboard/profile`. The existing SDK `updateProfile` method has no production caller.

The native `GET /api/me` route reads only names. It returns empty contact fields that no authority supplied. The Symfony `PUT /api/me` route remains the only profile-write authority.

## User journey

1. The member opens `/dashboard/profile/rediger`.
2. The loader authenticates the request.
3. The loader reads the member profile from native `GET /api/me`.
4. The page displays the stored first name, last name, email, and phone.
5. The member changes one or more fields.
6. The page validates all four fields before it sends a command.
7. The page sends one strict `PUT /api/me` command.
8. Profile locks the member name row and contact row in one transaction.
9. Profile rejects a stale revision or a conflicting command replay.
10. Profile updates both rows and records the command in the same transaction.
11. The page performs a fresh `GET /api/me` read.
12. The page displays the committed values.
13. A reload displays the same committed values.

## Authority model

```text
existing authentication seam
  -> authenticated personId and current role
  -> Profile.readOwnProfile(personId)
  -> Profile.updateOwnProfile(command, personId)
       -> Database transaction
          -> person_profiles
          -> person_contact_profiles
          -> profile_self_edit_commands
  -> UserProfile observation
```

Profile owns these mutable fields:

- `firstName`
- `lastName`
- `email`
- `phone`

Identity continues to own credentials, sessions, and roles. This slice does not change the authentication mechanism.

The browser does not supply a person ID or role. The server gets the person ID from the authenticated actor.

The command does not include gender, field of study, account number, username, or profile photo. The strict decoder rejects these extra fields.

The page removes controls for fields that have no native write authority. The page must not display fixture values outside fixture mode.

## Domain contract

`UserProfile` is the self-profile observation:

- `personId`
- `firstName`
- `lastName`
- `email`
- `phone`
- `role`
- `nameRevision`
- `contactRevision`

`role` is a read-only projection from the authenticated actor. Profile does not persist this field.

`UpdateOwnProfileCommand` contains:

- `_tag: "UpdateOwnProfile"`
- `commandId`
- `expectedNameRevision`
- `expectedContactRevision`
- `firstName`
- `lastName`
- `email`
- `phone`

The server supplies the actor person ID separately. The decoded command cannot represent a cross-person update.

Names contain 1 through 100 characters after trimming. Email and phone use the existing Profile schemas.

A successful command increments both revisions by one. The result contains the committed `UserProfile` fields without the actor role.

## Concurrency and replay laws

Profile locks both rows before it compares revisions. The transaction fails if one expected revision is stale.

`commandId` has one canonical payload. The payload includes the actor person ID and all decoded command fields.

A replay with the same command ID and canonical payload returns the original committed result. It does not update either row again.

A replay with the same command ID and different canonical bytes fails with a typed conflict. The failure does not change data.

The audit row and both profile rows commit atomically. A partial profile update is not representable.

## HTTP and SDK contract

`GET /api/me` requires authentication. It returns one strict `UserProfile` observation.

`PUT /api/me` requires authentication. It accepts only `UpdateOwnProfileCommand`. It returns the fresh strict `UserProfile` observation.

The SDK decodes both request and response schemas. The SDK does not accept `Partial<UserProfile>` for an update.

HTTP maps failures as follows:

| Failure | Status |
|---|---:|
| Missing or invalid authentication | 401 |
| Strict decode failure | 422 |
| Missing Profile row or contact row | 404 |
| Stale revision | 409 |
| Conflicting command replay | 409 |
| Database failure | 503 |

## Foldkit ownership

The route loader authenticates and returns the first profile observation. React Router owns routing and the authentication boundary.

One Foldkit custom element owns all profile-edit interaction state. Its `Model`, `Message`, `Update`, commands, and view own:

- editable field values
- field validation
- submit state
- command failure state
- the fresh committed observation

React `useState`, `useEffect`, `useFetcher`, React Hook Form, Zod, and fixture helpers do not own this journey.

After a successful command, the Foldkit program performs a fresh read before it replaces the displayed profile.

## Explicit exclusions

This slice does not add profile-photo storage, account-number storage, gender editing, or field-of-study membership changes.

This slice does not add the legacy email-change notification. A later notification slice can consume an explicit Profile audit event.

This slice does not cut over Identity credentials, sessions, passwords, or access-policy authority.

This slice does not authorize production deployment or production data migration.

## Evidence

The focused proof uses deterministic non-production data and a disposable PostgreSQL database.

The real-browser journey must:

1. start the native backend and dashboard;
2. authenticate as one seeded member;
3. open `/dashboard/profile/rediger`;
4. display the seeded native values;
5. edit all four writable fields;
6. save the command;
7. observe the fresh values in the page;
8. reload and observe the same values;
9. attempt a stale revision and observe a conflict;
10. replay one command and observe one revision increment;
11. record zero Symfony requests;
12. record no fixture canary;
13. pass an automated accessibility check.

The PostgreSQL proof must run two conflicting connections. Exactly one command can commit from the same expected revisions.

## Definition of done

1. This frozen contract precedes implementation commits.
2. Profile exposes explicit read-own and update-own programs.
3. The Database Layer owns both profile tables and the command-audit table.
4. One transaction enforces atomic updates, optimistic revisions, replay, and conflict behavior.
5. Native `GET /api/me` returns stored names and contact data without empty placeholder fields.
6. Native `PUT /api/me` is the only production profile-write call from the dashboard.
7. The SDK uses strict request and response schemas.
8. `/dashboard/profile/rediger` uses the shared Foldkit shell and one Foldkit profile program.
9. The production route has no fixture data, React interaction state, React Hook Form, or Zod form schema.
10. The profile-edit page removes fields that this authority does not own.
11. Focused model, Profile, database, HTTP, SDK, Update, accessibility, and browser checks pass.
12. Root type, format, lint, build, and test gates pass on the committed revision.

## Falsifiers

This slice is incomplete if one condition occurs:

- Production profile edit displays `getProfileData()` or another fixture value.
- The submit action reports success without a decoded native `PUT /api/me` command.
- The browser supplies a person ID or writable role.
- The command accepts gender, field of study, account number, username, or profile photo.
- One actor can update another person.
- A same-ID, different-payload replay commits.
- A stale revision overwrites a newer profile.
- One table updates without the other table and audit row.
- Native `GET /api/me` returns empty contact placeholders instead of stored values.
- The page replaces state from the write response without a fresh read.
- Symfony receives a production profile read or write.
- A fixture or mocked-transport run is presented as real-browser evidence.
