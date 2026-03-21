# My Receipts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build user-facing receipt page with create/edit/delete and file upload.
**Architecture:** New list endpoint + frontend route with React Router actions for mutations.
**Tech Stack:** Symfony 6.4 / API Platform 3.4, React Router v7, shadcn UI, TanStack Table
**Spec:** docs/superpowers/specs/2026-03-21-my-receipts-design.md

---

## Chunk 1: Backend — Repository Method

### Task 1: Add `findByUserOrdered()` to ReceiptRepository

**Files:**
- Modify: `apps/server/src/App/Operations/Infrastructure/Repository/ReceiptRepository.php`
- Test: `apps/server/tests/App/Operations/Infrastructure/Repository/ReceiptRepositoryTest.php`

**Context:** The existing `findByUser()` has no ordering or status filter. The new method follows the same shape as `findByDepartment()` — optional status filter, ordering by `submitDate DESC`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/tests/App/Operations/Infrastructure/Repository/ReceiptRepositoryTest.php`:

```php
public function testFindByUserOrderedReturnsOnlyUserReceipts(): void
{
    /** @var \App\Identity\Infrastructure\Entity\User|null $user */
    $user = self::getContainer()->get('doctrine')
        ->getRepository(\App\Identity\Infrastructure\Entity\User::class)
        ->findOneBy([]);

    if ($user === null) {
        $this->markTestSkipped('No user in fixtures');
    }

    $receipts = $this->repo->findByUserOrdered($user);

    foreach ($receipts as $receipt) {
        $this->assertSame(
            $user->getId(),
            $receipt->getUser()->getId(),
            'Receipt must belong to the queried user'
        );
    }
}

public function testFindByUserOrderedWithStatusFilter(): void
{
    /** @var \App\Identity\Infrastructure\Entity\User|null $user */
    $user = self::getContainer()->get('doctrine')
        ->getRepository(\App\Identity\Infrastructure\Entity\User::class)
        ->findOneBy([]);

    if ($user === null) {
        $this->markTestSkipped('No user in fixtures');
    }

    $receipts = $this->repo->findByUserOrdered($user, Receipt::STATUS_PENDING);

    foreach ($receipts as $receipt) {
        $this->assertSame(Receipt::STATUS_PENDING, $receipt->getStatus());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/Operations/Infrastructure/Repository/ReceiptRepositoryTest.php --no-coverage`
Expected: FAIL — method `findByUserOrdered` does not exist.

- [ ] **Step 3: Implement `findByUserOrdered()`**

Add to `apps/server/src/App/Operations/Infrastructure/Repository/ReceiptRepository.php`:

```php
/**
 * @return Receipt[]
 */
public function findByUserOrdered(User $user, ?string $status = null): array
{
    $qb = $this->createQueryBuilder('receipt')
        ->where('receipt.user = :user')
        ->setParameter('user', $user)
        ->orderBy('receipt.submitDate', 'DESC');

    if ($status !== null) {
        $qb->andWhere('receipt.status = :status')
            ->setParameter('status', $status);
    }

    return $qb->getQuery()->getResult();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/Operations/Infrastructure/Repository/ReceiptRepositoryTest.php --no-coverage`
Expected: PASS (or SKIP if no receipts in fixtures — both acceptable)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/App/Operations/Infrastructure/Repository/ReceiptRepository.php apps/server/tests/App/Operations/Infrastructure/Repository/ReceiptRepositoryTest.php
git commit -m "feat(receipts): add findByUserOrdered repository method with status filter"
```

---

## Chunk 2: Backend — List Endpoint

### Task 2: Create `UserReceiptListResource` and `UserReceiptListProvider`

**Files:**
- Create: `apps/server/src/App/Operations/Api/Resource/UserReceiptListResource.php`
- Create: `apps/server/src/App/Operations/Api/State/UserReceiptListProvider.php`

**Context:** Follow the `AdminReceiptListResource` / `AdminReceiptListProvider` pattern exactly. Key differences: no `userName` field (user sees their own receipts), security is `ROLE_USER` (not `ROLE_TEAM_MEMBER`), `paginationEnabled: false` (user volumes are small), route is `/my/receipts`.

- [ ] **Step 1: Create `UserReceiptListResource`**

```php
<?php

declare(strict_types=1);

namespace App\Operations\Api\Resource;

use ApiPlatform\Metadata\ApiResource;
use ApiPlatform\Metadata\GetCollection;
use App\Operations\Api\State\UserReceiptListProvider;

#[ApiResource(
    operations: [
        new GetCollection(
            uriTemplate: '/my/receipts',
            provider: UserReceiptListProvider::class,
            security: "is_granted('ROLE_USER')",
            paginationEnabled: false,
        ),
    ],
)]
class UserReceiptListResource
{
    public ?int $id = null;

    public ?string $visualId = null;

    public ?string $description = null;

    public ?float $sum = null;

    public ?string $receiptDate = null;

    public ?string $submitDate = null;

    public ?string $status = null;

    public ?string $refundDate = null;
}
```

- [ ] **Step 2: Create `UserReceiptListProvider`**

```php
<?php

declare(strict_types=1);

namespace App\Operations\Api\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProviderInterface;
use App\Identity\Infrastructure\Entity\User;
use App\Operations\Api\Resource\UserReceiptListResource;
use App\Operations\Infrastructure\Repository\ReceiptRepository;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

class UserReceiptListProvider implements ProviderInterface
{
    public function __construct(
        private readonly ReceiptRepository $receiptRepository,
        private readonly Security $security,
    ) {
    }

    /**
     * @return UserReceiptListResource[]
     */
    public function provide(Operation $operation, array $uriVariables = [], array $context = []): array
    {
        $user = $this->security->getUser();
        if (!$user instanceof User) {
            throw new AccessDeniedHttpException();
        }

        $filters = $context['filters'] ?? [];
        $status = $filters['status'] ?? null;

        $receipts = $this->receiptRepository->findByUserOrdered($user, $status);

        $resources = [];
        foreach ($receipts as $receipt) {
            $resource = new UserReceiptListResource();
            $resource->id = $receipt->getId();
            $resource->visualId = $receipt->getVisualId();
            $resource->description = $receipt->getDescription();
            $resource->sum = $receipt->getSum();
            $resource->receiptDate = $receipt->getReceiptDate()?->format('Y-m-d');
            $resource->submitDate = $receipt->getSubmitDate()?->format('Y-m-d');
            $resource->status = $receipt->getStatus();
            $resource->refundDate = $receipt->getRefundDate()?->format('Y-m-d');
            $resources[] = $resource;
        }

        return $resources;
    }
}
```

- [ ] **Step 3: Clear cache and verify container compiles**

Run: `cd apps/server && php bin/console cache:clear`
Expected: No errors.

- [ ] **Step 4: Smoke test the route**

Run: `cd apps/server && php bin/console debug:router | grep "my/receipts"`
Expected: Shows `GET /api/my/receipts`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/App/Operations/Api/Resource/UserReceiptListResource.php apps/server/src/App/Operations/Api/State/UserReceiptListProvider.php
git commit -m "feat(receipts): add GET /api/my/receipts user-scoped list endpoint"
```

---

### Task 3: Unit test `UserReceiptListProvider`

**Files:**
- Create: `apps/server/tests/App/Operations/Api/State/UserReceiptListProviderTest.php`

**Context:** Mirror the `AdminReceiptListProviderTest` pattern. Tests: returns only the current user's receipts, passes status filter to repo, throws on unauthenticated.

- [ ] **Step 1: Write the test**

```php
<?php

declare(strict_types=1);

namespace App\Tests\App\Operations\Api\State;

use ApiPlatform\Metadata\GetCollection;
use App\Identity\Infrastructure\Entity\User;
use App\Operations\Api\Resource\UserReceiptListResource;
use App\Operations\Api\State\UserReceiptListProvider;
use App\Operations\Infrastructure\Entity\Receipt;
use App\Operations\Infrastructure\Repository\ReceiptRepository;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

class UserReceiptListProviderTest extends TestCase
{
    public function testReturnsCurrentUserReceipts(): void
    {
        $user = $this->createMock(User::class);

        $receipt = $this->createMock(Receipt::class);
        $receipt->method('getId')->willReturn(1);
        $receipt->method('getVisualId')->willReturn('abc123');
        $receipt->method('getDescription')->willReturn('Bus ticket');
        $receipt->method('getSum')->willReturn(150.0);
        $receipt->method('getReceiptDate')->willReturn(new \DateTime('2026-01-10'));
        $receipt->method('getSubmitDate')->willReturn(new \DateTime('2026-01-10'));
        $receipt->method('getStatus')->willReturn(Receipt::STATUS_PENDING);
        $receipt->method('getRefundDate')->willReturn(null);

        $repo = $this->createMock(ReceiptRepository::class);
        $repo->expects($this->once())
            ->method('findByUserOrdered')
            ->with($user, null)
            ->willReturn([$receipt]);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($user);

        $provider = new UserReceiptListProvider($repo, $security);
        $result = $provider->provide(new GetCollection(), []);

        $this->assertCount(1, $result);
        $this->assertInstanceOf(UserReceiptListResource::class, $result[0]);
        $this->assertSame(1, $result[0]->id);
        $this->assertSame('abc123', $result[0]->visualId);
        $this->assertSame(Receipt::STATUS_PENDING, $result[0]->status);
        $this->assertNull($result[0]->refundDate);
    }

    public function testPassesStatusFilterToRepository(): void
    {
        $user = $this->createMock(User::class);

        $repo = $this->createMock(ReceiptRepository::class);
        $repo->expects($this->once())
            ->method('findByUserOrdered')
            ->with($user, 'pending')
            ->willReturn([]);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($user);

        $provider = new UserReceiptListProvider($repo, $security);
        $result = $provider->provide(new GetCollection(), [], ['filters' => ['status' => 'pending']]);

        $this->assertSame([], $result);
    }

    public function testThrowsWhenNotAuthenticated(): void
    {
        $repo = $this->createMock(ReceiptRepository::class);
        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn(null);

        $provider = new UserReceiptListProvider($repo, $security);

        $this->expectException(AccessDeniedHttpException::class);
        $provider->provide(new GetCollection(), []);
    }

    public function testOtherUsersReceiptsNotIncluded(): void
    {
        $user = $this->createMock(User::class);

        // Repository is user-scoped — if it returns empty, no other user's receipts appear
        $repo = $this->createMock(ReceiptRepository::class);
        $repo->method('findByUserOrdered')->with($user, null)->willReturn([]);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($user);

        $provider = new UserReceiptListProvider($repo, $security);
        $result = $provider->provide(new GetCollection(), []);

        $this->assertSame([], $result);
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/Operations/Api/State/UserReceiptListProviderTest.php --no-coverage`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/App/Operations/Api/State/UserReceiptListProviderTest.php
git commit -m "test(receipts): unit tests for UserReceiptListProvider"
```

---

### Task 4: E2E API tests for `GET /api/my/receipts`

**Files:**
- Create: `apps/server/tests/AppBundle/Api/UserReceiptListApiTest.php`

**Context:** Follow the `AdminReceiptListApiTest` pattern exactly. Uses `JwtAuthTrait` for JWT tokens, `BaseWebTestCase` for the client. The fixture user `assistent` has `ROLE_USER` and should be able to access their own receipts.

- [ ] **Step 1: Write the test**

```php
<?php

declare(strict_types=1);

namespace Tests\AppBundle\Api;

use Tests\BaseWebTestCase;

class UserReceiptListApiTest extends BaseWebTestCase
{
    use JwtAuthTrait;

    public function testListRequiresAuth(): void
    {
        $client = static::createClient();
        $client->request('GET', '/api/my/receipts', [], [], [
            'HTTP_ACCEPT' => 'application/ld+json',
        ]);

        $this->assertResponseStatusCodeSame(401);
    }

    public function testListAllowedForAuthenticatedUser(): void
    {
        $token = $this->getJwtToken('assistent', '1234');

        $client = static::createClient();
        $client->request('GET', '/api/my/receipts', [], [], [
            'HTTP_AUTHORIZATION' => 'Bearer '.$token,
            'HTTP_ACCEPT' => 'application/ld+json',
        ]);

        $this->assertResponseStatusCodeSame(200);

        $data = json_decode($client->getResponse()->getContent(), true);
        $this->assertArrayHasKey('hydra:member', $data);
        $this->assertIsArray($data['hydra:member']);
    }

    public function testListReturnsCorrectShape(): void
    {
        $token = $this->getJwtToken('assistent', '1234');

        $client = static::createClient();
        $client->request('GET', '/api/my/receipts', [], [], [
            'HTTP_AUTHORIZATION' => 'Bearer '.$token,
            'HTTP_ACCEPT' => 'application/ld+json',
        ]);

        $this->assertResponseStatusCodeSame(200);

        $data = json_decode($client->getResponse()->getContent(), true);
        $members = $data['hydra:member'];

        foreach ($members as $receipt) {
            $this->assertArrayHasKey('id', $receipt);
            $this->assertArrayHasKey('visualId', $receipt);
            $this->assertArrayHasKey('description', $receipt);
            $this->assertArrayHasKey('sum', $receipt);
            $this->assertArrayHasKey('status', $receipt);
            $this->assertContains($receipt['status'], ['pending', 'refunded', 'rejected']);
            // userName must NOT be present (user sees own receipts only)
            $this->assertArrayNotHasKey('userName', $receipt);
        }
    }

    public function testListFiltersByStatus(): void
    {
        $token = $this->getJwtToken('assistent', '1234');

        $client = static::createClient();
        $client->request('GET', '/api/my/receipts?status=pending', [], [], [
            'HTTP_AUTHORIZATION' => 'Bearer '.$token,
            'HTTP_ACCEPT' => 'application/ld+json',
        ]);

        $this->assertResponseStatusCodeSame(200);

        $data = json_decode($client->getResponse()->getContent(), true);
        $members = $data['hydra:member'];

        foreach ($members as $receipt) {
            $this->assertSame('pending', $receipt['status']);
        }
    }
}
```

- [ ] **Step 2: Run the test**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/AppBundle/Api/UserReceiptListApiTest.php --no-coverage`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/AppBundle/Api/UserReceiptListApiTest.php
git commit -m "test(receipts): e2e API tests for GET /api/my/receipts"
```

---

## Chunk 3: SDK Regeneration

### Task 5: Regenerate SDK types

**Files:**
- Modify: `packages/sdk/openapi.json`
- Modify: `packages/sdk/generated/api.d.ts`

- [ ] **Step 1: Export the OpenAPI spec**

Run: `cd apps/server && php bin/console api:openapi:export --output=../../packages/sdk/openapi.json`
Expected: File updated. Verify: `grep "my/receipts" ../../packages/sdk/openapi.json` — should find the new endpoint.

- [ ] **Step 2: Regenerate TypeScript types**

Run: `cd packages/sdk && bun run generate`
Expected: `generated/api.d.ts` updated with new types for `/api/my/receipts`.

- [ ] **Step 3: Build the SDK**

Run: `cd packages/sdk && bun run build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/openapi.json packages/sdk/generated/api.d.ts
git commit -m "chore(sdk): regenerate types for user receipt list endpoint"
```

---

## Chunk 4: Frontend — My Receipts Page

### Task 6: Create `ReceiptFormDialog` component

**Files:**
- Create: `apps/dashboard/app/components/receipts/ReceiptFormDialog.tsx`

**Context:** Dialog for create and edit. On create: all fields required including file. On edit: description/sum/receiptDate pre-populated, file optional with "Last opp ny fil for å erstatte" hint. Uses hidden `_intent` and `receiptId` fields so the parent route's action can dispatch correctly.

- [ ] **Step 1: Create the component**

```tsx
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "react-router";

type Receipt = {
  id: number;
  description: string;
  sum: number;
  receiptDate: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receipt?: Receipt; // undefined = create mode
  error?: string;
};

// biome-ignore lint/style/noDefaultExport: component export
export default function ReceiptFormDialog({ open, onOpenChange, receipt, error }: Props) {
  const isEdit = receipt !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Rediger utlegg" : "Legg til utlegg"}</DialogTitle>
        </DialogHeader>

        <Form method="post" encType="multipart/form-data">
          <input type="hidden" name="_intent" value={isEdit ? "edit" : "create"} />
          {isEdit && <input type="hidden" name="receiptId" value={receipt.id} />}

          <div className="flex flex-col gap-4 py-4">
            {error && (
              <p className="rounded bg-red-50 p-3 text-red-600 text-sm">{error}</p>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="description" className="text-sm font-medium">
                Beskrivelse <span className="text-red-500">*</span>
              </label>
              <textarea
                id="description"
                name="description"
                required
                rows={3}
                defaultValue={receipt?.description ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Beskriv utlegget"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="sum" className="text-sm font-medium">
                Beløp (NOK) <span className="text-red-500">*</span>
              </label>
              <input
                id="sum"
                name="sum"
                type="number"
                required
                min="0.01"
                step="0.01"
                defaultValue={receipt?.sum ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="0.00"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="receiptDate" className="text-sm font-medium">
                Dato <span className="text-red-500">*</span>
              </label>
              <input
                id="receiptDate"
                name="receiptDate"
                type="date"
                required
                defaultValue={receipt?.receiptDate ?? ""}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="picture" className="text-sm font-medium">
                Kvitteringsbilde {!isEdit && <span className="text-red-500">*</span>}
              </label>
              <input
                id="picture"
                name="picture"
                type="file"
                accept="image/*,application/pdf"
                required={!isEdit}
                className="text-sm"
              />
              {isEdit && (
                <p className="text-muted-foreground text-xs">
                  Last opp ny fil for å erstatte eksisterende kvittering.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Avbryt
            </Button>
            <Button type="submit">
              {isEdit ? "Lagre endringer" : "Legg til"}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/app/components/receipts/ReceiptFormDialog.tsx
git commit -m "feat(dashboard): add ReceiptFormDialog component for create/edit"
```

---

### Task 7: Create `DeleteReceiptDialog` component

**Files:**
- Create: `apps/dashboard/app/components/receipts/DeleteReceiptDialog.tsx`

**Context:** Uses shadcn `AlertDialog` (already installed from the admin receipts task). Submits via `fetcher.submit` like the admin status actions — avoids full-page navigation, keeps the dialog close animation intact.

- [ ] **Step 1: Create the component**

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useFetcher } from "react-router";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receiptId: number;
};

// biome-ignore lint/style/noDefaultExport: component export
export default function DeleteReceiptDialog({ open, onOpenChange, receiptId }: Props) {
  const fetcher = useFetcher();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Slett utlegg</AlertDialogTitle>
          <AlertDialogDescription>
            Er du sikker? Utlegget vil bli slettet permanent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Avbryt</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              fetcher.submit(
                { _intent: "delete", receiptId: String(receiptId) },
                { method: "post" },
              );
              onOpenChange(false);
            }}
          >
            Slett
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/app/components/receipts/DeleteReceiptDialog.tsx
git commit -m "feat(dashboard): add DeleteReceiptDialog component"
```

---

### Task 8: Create the `dashboard.mine-utlegg._index.tsx` route

**Files:**
- Create: `apps/dashboard/app/routes/dashboard.mine-utlegg._index.tsx`

**Context:** New route. Loader fetches from `GET /api/my/receipts`. Single action handles create/edit/delete via `_intent`. Create/edit use raw `fetch()` with `FormData` for multipart (SDK doesn't support multipart). Delete uses the SDK client. `API_BASE_URL` comes from `apiUrl` imported from `@vektorprogrammet/sdk` — same base the SDK client uses, keeping raw fetch consistent.

- [ ] **Step 1: Write the complete route file**

```tsx
import DeleteReceiptDialog from "@/components/receipts/DeleteReceiptDialog";
import ReceiptFormDialog from "@/components/receipts/ReceiptFormDialog";
import { DataTable } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import type { ColumnDef } from "@tanstack/react-table";
import { apiUrl, isFixtureMode } from "@vektorprogrammet/sdk";
import { useState } from "react";
import { useActionData, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.mine-utlegg._index";

type Receipt = {
  id: number;
  visualId: string;
  description: string;
  sum: number;
  receiptDate: string | null;
  submitDate: string | null;
  status: "pending" | "refunded" | "rejected";
  refundDate: string | null;
};

const mockReceipts: Receipt[] = [
  { id: 1, visualId: "1a2b3c", description: "Bussreise til skolen", sum: 150, receiptDate: "2025-01-10", submitDate: "2025-01-10", status: "pending", refundDate: null },
  { id: 2, visualId: "4d5e6f", description: "Materiell til undervisning", sum: 320, receiptDate: "2025-01-12", submitDate: "2025-01-12", status: "refunded", refundDate: "2025-02-01" },
  { id: 3, visualId: "7a8b9c", description: "Lunsj teamsamling", sum: 200, receiptDate: "2025-01-14", submitDate: "2025-01-14", status: "rejected", refundDate: null },
];

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { receipts: mockReceipts };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  const { data } = await client.GET("/api/my/receipts" as any);

  return { receipts: ((data as any)?.["hydra:member"] as Receipt[]) ?? [] };
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("_intent")?.toString();

  if (intent === "delete") {
    const id = form.get("receiptId")?.toString();
    if (!id) return { error: "Manglende ID" };

    const { error } = await client.DELETE("/api/receipts/{id}" as any, {
      params: { path: { id } },
    });

    if (error) return { error: "Sletting feilet" };
    return { success: true };
  }

  if (intent === "create" || intent === "edit") {
    const method = intent === "create" ? "POST" : "PUT";
    const id = form.get("receiptId")?.toString();
    const url = intent === "create"
      ? "/api/receipts"
      : `/api/receipts/${id}`;

    const body = new FormData();
    body.append("description", form.get("description")?.toString() ?? "");
    body.append("sum", form.get("sum")?.toString() ?? "");
    const receiptDate = form.get("receiptDate")?.toString();
    if (receiptDate) body.append("receiptDate", receiptDate);
    const file = form.get("picture");
    if (file instanceof File && file.size > 0) body.append("picture", file);

    const res = await fetch(`${apiUrl}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
    });

    if (!res.ok) return { error: "Lagring feilet" };
    return { success: true };
  }

  return { error: "Ukjent handling" };
}

const statusLabels: Record<string, string> = {
  pending: "Venter",
  refunded: "Refundert",
  rejected: "Avvist",
};

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  refunded: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status] ?? ""}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

function ActionsCell({
  receipt,
  onEdit,
  onDelete,
}: {
  receipt: Receipt;
  onEdit: (receipt: Receipt) => void;
  onDelete: (id: number) => void;
}) {
  if (receipt.status !== "pending") return null;

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => onEdit(receipt)}>
        Rediger
      </Button>
      <Button variant="destructive" size="sm" onClick={() => onDelete(receipt.id)}>
        Slett
      </Button>
    </div>
  );
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const { receipts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const [createOpen, setCreateOpen] = useState(false);
  const [editReceipt, setEditReceipt] = useState<Receipt | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const columns: ColumnDef<Receipt>[] = [
    { accessorKey: "visualId", header: "ID" },
    {
      accessorKey: "description",
      header: "Beskrivelse",
      cell: ({ row }) => (
        <span className="max-w-[200px] truncate block" title={row.original.description}>
          {row.original.description}
        </span>
      ),
    },
    {
      accessorKey: "sum",
      header: "Beløp",
      cell: ({ row }) => `${row.original.sum} kr`,
    },
    {
      accessorKey: "receiptDate",
      header: "Dato",
      cell: ({ row }) => row.original.receiptDate ?? "—",
    },
    {
      accessorKey: "submitDate",
      header: "Sendt inn",
      cell: ({ row }) => row.original.submitDate ?? "—",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "Handlinger",
      cell: ({ row }) => (
        <ActionsCell
          receipt={row.original}
          onEdit={setEditReceipt}
          onDelete={setDeleteId}
        />
      ),
    },
  ];

  const actionError = actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-semibold text-2xl">Mine Utlegg</h1>
          <Button onClick={() => setCreateOpen(true)}>Legg til utlegg</Button>
        </div>

        {actionError && (
          <p className="mb-4 rounded bg-red-50 p-3 text-red-600 text-sm">{actionError}</p>
        )}

        <DataTable columns={columns} data={receipts ?? []} />
      </div>

      <ReceiptFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        error={actionError}
      />

      {editReceipt && (
        <ReceiptFormDialog
          open={editReceipt !== null}
          onOpenChange={(open) => { if (!open) setEditReceipt(null); }}
          receipt={editReceipt}
          error={actionError}
        />
      )}

      {deleteId !== null && (
        <DeleteReceiptDialog
          open={deleteId !== null}
          onOpenChange={(open) => { if (!open) setDeleteId(null); }}
          receiptId={deleteId}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 2: Verify types**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors. If `as any` casts for un-regenerated SDK paths produce errors, ensure SDK was regenerated first (Task 5).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/app/routes/dashboard.mine-utlegg._index.tsx
git commit -m "feat(dashboard): add Mine Utlegg page with create/edit/delete and file upload

- Loader fetches GET /api/my/receipts
- Action dispatches create/edit (raw fetch multipart) and delete (SDK)
- DataTable with status badges, edit/delete for pending receipts only
- ReceiptFormDialog and DeleteReceiptDialog for mutations"
```

---

### Task 9: Wire the navigation link

**Files:**
- Modify: `apps/dashboard/app/routes/dashboard.tsx`

**Context:** The "Mine Utlegg" `DropdownMenuItem` at line ~149 is currently a bare `DropdownMenuItem` with no link. Wrap it in a `Link` following the same pattern as the "Profil" item directly above it.

- [ ] **Step 1: Update the navigation item**

In `apps/dashboard/app/routes/dashboard.tsx`, find:

```tsx
<DropdownMenuItem>
  <Receipt />
  Mine Utlegg
</DropdownMenuItem>
```

Replace with:

```tsx
<Link to={href("/dashboard/mine-utlegg")} prefetch="intent">
  <DropdownMenuItem>
    <Receipt />
    Mine Utlegg
  </DropdownMenuItem>
</Link>
```

- [ ] **Step 2: Verify types**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/app/routes/dashboard.tsx
git commit -m "feat(dashboard): wire Mine Utlegg navigation link to /dashboard/mine-utlegg"
```

---

## Chunk 5: Verification

### Task 10: End-to-end verification

- [ ] **Step 1: Run the full PHP test suite**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit --no-coverage > /tmp/phpunit-final.txt 2>&1 && tail -5 /tmp/phpunit-final.txt`
Expected: All tests pass.

- [ ] **Step 2: Run PHPStan**

Run: `cd apps/server && composer analyse`
Expected: 0 errors (with baseline).

- [ ] **Step 3: Run dashboard typecheck**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Verify route is registered**

Run: `cd apps/server && php bin/console debug:router | grep "my/receipts"`
Expected: `GET /api/my/receipts` present.

- [ ] **Step 5: Fixture mode smoke test**

Run: `cd apps/dashboard && bun run dev`
Navigate to `/dashboard/mine-utlegg`. Verify:
- Table renders with 3 mock receipts
- "Venter" receipt shows Rediger + Slett buttons
- "Refundert" and "Avvist" receipts show no buttons
- "Legg til utlegg" button opens the create dialog
- Dialog has Beskrivelse, Beløp, Dato, Kvitteringsbilde fields
- Slett button opens the delete confirmation dialog
