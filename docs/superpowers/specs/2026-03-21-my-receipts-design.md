# My Receipts — Design Spec

## Goal

Build the user-facing "Mine Utlegg" page in the dashboard where authenticated users can view, create, edit, and delete their own receipts. Includes file upload (image or PDF) for receipt pictures.

## Scope

- **In:** User list view, create, edit (pending only), delete (pending only), file upload
- **Out:** Admin actions (status changes, cross-department views), receipt statistics

---

## Backend

### New: `GET /api/my/receipts`

No collection endpoint currently exists for a user's own receipts. Add one.

#### New Resource: `UserReceiptListResource`

```php
class UserReceiptListResource
{
    public ?int $id = null;
    public ?string $visualId = null;
    public ?string $description = null;
    public ?float $sum = null;
    public ?string $receiptDate = null;    // Y-m-d, nullable
    public ?string $submitDate = null;     // Y-m-d, nullable
    public ?string $status = null;         // pending|refunded|rejected
    public ?string $refundDate = null;     // Y-m-d, nullable
}
```

No `picturePath` exposed — file download is out of scope for MVP.

#### New Provider: `UserReceiptListProvider`

- **Operation type:** `GetCollection` on `UserReceiptListResource`
- **Route:** `GET /api/my/receipts`
- **Security:** `ROLE_USER`
- Requires a new `ReceiptRepository::findByUserOrdered(User $user, ?string $status = null): Receipt[]` method (same pattern as existing `findByDepartment()`), ordering by submitDate DESC with optional status filtering. The existing `findByUser` has no ordering or status filter and is not used here.
- Current user resolved via `Security::getUser()`
- Orders by submitDate DESC (newest first). Note: submitDate is always set on construction, so NULL LAST handling is defensive only — a simple DESC sort suffices.
- Optional filter: `?status=pending|refunded|rejected` — absent returns all
- `paginationEnabled: false` — user receipt volumes are small enough not to warrant pagination
- Formats dates as `Y-m-d` (null-safe)

#### Existing Endpoints (unchanged)

| Method | Path | Security | Notes |
|--------|------|----------|-------|
| `POST /api/receipts` | Create | `ROLE_USER` | multipart/form-data |
| `PUT /api/receipts/{id}` | Edit own + pending only | `ROLE_USER` | multipart/form-data |
| `DELETE /api/receipts/{id}` | Owner + pending, or `ROLE_TEAM_LEADER` | `ROLE_USER` | — |

The existing write endpoints already scope to the current user and enforce pending-only edits/deletes. No changes needed.

### SDK Regeneration

After backend changes:
1. `cd apps/server && php bin/console api:openapi:export --output=../../packages/sdk/openapi.json`
2. `cd packages/sdk && bun run generate`

---

## Frontend

### Route: `dashboard.mine-utlegg._index.tsx`

New file. The "Mine Utlegg" sidebar item currently links nowhere — this route provides the destination.

#### Loader

```typescript
export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  const { data } = await client.GET("/api/my/receipts");

  return { receipts: data?.["hydra:member"] ?? [] };
}
```

#### Action (Mutation Dispatch)

Single action handles create, edit, and delete via an `_intent` field on the form. File upload requires raw `fetch()` since openapi-fetch does not support multipart natively.

```typescript
export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("_intent")?.toString();

  if (intent === "delete") {
    const id = form.get("receiptId")?.toString();
    const { error } = await client.DELETE("/api/receipts/{id}", {
      params: { path: { id } },
    });
    if (error) return { error: "Sletting feilet" };
    return { success: true };
  }

  if (intent === "create" || intent === "edit") {
    // File upload via raw fetch — SDK does not support multipart
    const method = intent === "create" ? "POST" : "PUT";
    const id = form.get("receiptId")?.toString();
    const url = intent === "create"
      ? "/api/receipts"
      : `/api/receipts/${id}`;

    const body = new FormData();
    body.append("description", form.get("description") ?? "");
    body.append("sum", form.get("sum") ?? "");
    const receiptDate = form.get("receiptDate");
    if (receiptDate) body.append("receiptDate", receiptDate);
    const file = form.get("picture");
    if (file instanceof File && file.size > 0) body.append("picture", file);

    const res = await fetch(`${API_BASE_URL}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
    });

    if (!res.ok) return { error: "Lagring feilet" };
    return { success: true };
  }

  return { error: "Ukjent handling" };
}
```

`API_BASE_URL` should use `apiUrl` from `@vektorprogrammet/sdk` — the same base URL that `createAuthenticatedClient` uses internally, keeping the raw fetch consistent with the SDK.

#### Component

**Layout:**
- Page heading: "Mine Utlegg"
- "Legg til utlegg" button (top right) → opens create dialog
- DataTable (existing TanStack Table wrapper)

**Columns:**

| Column | Source | Notes |
|--------|--------|-------|
| Visual ID | `visualId` | Hex identifier |
| Beskrivelse | `description` | Truncated at ~60 chars |
| Beløp | `sum` | Formatted as `{n} kr` |
| Dato | `receiptDate` | Locale formatted; empty if null |
| Sendt inn | `submitDate` | Locale formatted; empty if null |
| Status | `status` | Badge (see below) |
| Handlinger | — | Edit + Delete, conditional on status |

**Status badges:**

| Status | Badge color |
|--------|-------------|
| `pending` | Yellow |
| `refunded` | Green |
| `rejected` | Red |

**Action buttons per status:**

| Status | Edit | Delete |
|--------|------|--------|
| `pending` | Yes | Yes |
| `refunded` | No | No |
| `rejected` | No | No |

**Create/Edit dialog (`ReceiptFormDialog`):**
- Fields: Beskrivelse (textarea), Beløp (number input, NOK), Dato (date picker, **required**), Kvitteringsbilde (file input, image or PDF)
- The `receiptDate` field is required in the form. If omitted server-side, the API defaults to the server creation timestamp — making it required in the UI avoids this silent fallback and ensures the user always sets an explicit date.
- On edit: pre-populate description, sum, receiptDate. File input shows "Last opp ny fil for å erstatte" hint. File is optional on edit.
- Submit calls action with `_intent=create` or `_intent=edit`
- Validation: description required, sum > 0 required, receiptDate required, file required on create

**Delete dialog:**
- shadcn `AlertDialog`: "Er du sikker? Utlegget vil bli slettet permanent."
- Confirm calls action with `_intent=delete`

**Error display:** `useActionData()` renders an error banner below the dialog if the action returns `{ error }`.

#### Fixture Mode

When `isFixtureMode` is true, the loader returns mock receipt data shaped as `UserReceiptListResource[]`.

### Navigation

**File:** `apps/dashboard/app/components/layout/sidebar.tsx` (or wherever the user dropdown "Mine Utlegg" item is defined)

Add `to="/dashboard/mine-utlegg"` to the existing "Mine Utlegg" `<NavLink>` (currently has no route).

---

## File Upload — Detailed Design

The existing `FileUploader::uploadReceipt(Request $request)` in the backend:
- Reads the file from the raw Symfony `Request` object (not from a DTO)
- Picks the first file key it finds — the field **must** be named `picture`
- Validates MIME type (image or PDF)
- Returns the absolute path to the stored file

The API Platform write endpoints (`POST /api/receipts`, `PUT /api/receipts/{id}`) call this internally. From the frontend's perspective, the request must be `multipart/form-data` with the file field named `picture`.

**Why raw `fetch()` instead of the SDK:**
`openapi-fetch` serializes the request body as JSON by default. Even with `bodySerializer`, it cannot attach a `File` object. Using raw `fetch()` with a `FormData` body is the simplest correct approach. The SDK is still used for reads and deletes (no file involved).

**Cookie/token forwarding:** The action runs server-side in React Router. The JWT token is extracted via `requireAuth(request)` and forwarded as `Authorization: Bearer {token}` on the raw fetch to the API. This matches how `createAuthenticatedClient` works.

---

## State Machine Reference

```
pending ──→ refunded (terminal, admin action)
   │
   └──→ rejected (terminal, admin action)
```

From the **user's perspective** (actions available in "Mine Utlegg"):

```
pending: edit ✓, delete ✓
refunded: edit ✗, delete ✗  (terminal — no user actions)
rejected: edit ✗, delete ✗  (terminal — no user actions)
```

Both `refunded` and `rejected` are terminal from the user's perspective: no further user actions are possible. Admin reopen is out of scope for this feature.

Status transitions are admin-only (handled in the admin receipt page). Users can only manage receipts while they are still pending.

---

## Files

### New files

| File | Purpose |
|------|---------|
| `apps/server/src/App/Operations/Api/Resource/UserReceiptListResource.php` | List item DTO for user's own receipts |
| `apps/server/src/App/Operations/Api/State/UserReceiptListProvider.php` | User-scoped collection provider |
| `apps/dashboard/app/routes/dashboard.mine-utlegg._index.tsx` | Route: loader + action + page component |
| `apps/dashboard/app/components/receipts/ReceiptFormDialog.tsx` | Create/edit dialog with file upload field |
| `apps/dashboard/app/components/receipts/DeleteReceiptDialog.tsx` | Delete confirmation dialog |

### Modified files

| File | Change |
|------|--------|
| `apps/dashboard/app/components/layout/sidebar.tsx` (or user dropdown file) | Add `to="/dashboard/mine-utlegg"` to "Mine Utlegg" nav item |
| `packages/sdk/openapi.json` | Regenerated |
| `packages/sdk/generated/api.d.ts` | Regenerated |

---

## Testing

### Backend

- Unit test for `UserReceiptListProvider`: returns only receipts belonging to the current user
- Unit test for status filter: `?status=pending` returns only pending receipts for that user
- Unit test for `UserReceiptListProvider`: receipts from other users are not included
- E2E (WebTestCase) for `GET /api/my/receipts`: returns 200 with correct shape, requires authentication, returns 401 for unauthenticated request

### Frontend

- Loader returns receipt data (mock SDK call)
- Action with `_intent=delete` calls DELETE and returns success
- Action with `_intent=create` sends multipart request and returns success
- Create dialog opens on button click
- Edit/delete buttons absent for non-pending receipts
- Status badges render correct colors

---

## Sequence Diagram

```
User clicks "Legg til utlegg"
  → ReceiptFormDialog opens
  → User fills description, sum, date, attaches file
  → Form submits (_intent=create)
  → action() builds FormData, calls raw fetch POST /api/receipts
  → FileUploader validates and stores file
  → Receipt entity created with status=pending
  → action() returns { success: true }
  → React Router revalidates loader
  → Table refreshes, new receipt appears with status=pending

User clicks "Slett" on pending receipt
  → DeleteReceiptDialog opens
  → User confirms
  → Form submits (_intent=delete, receiptId)
  → action() calls SDK DELETE /api/receipts/{id}
  → API verifies ownership + pending status
  → Receipt deleted
  → action() returns { success: true }
  → React Router revalidates loader
  → Receipt removed from table
```
