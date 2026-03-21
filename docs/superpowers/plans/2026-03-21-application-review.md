# Application Review Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Enhance application review page with computed status, filtering, and interview assignment.
**Architecture:** Enhance existing list provider with status computation + rewrite frontend with actions.
**Tech Stack:** Symfony 6.4 / API Platform 3.4, React Router v7, shadcn UI, TanStack Table
**Spec:** docs/superpowers/specs/2026-03-21-application-review-design.md

---

## Chunk 1: Backend — Inject ApplicationStatusRule into AdminApplicationListProvider

### Task 1: Add `applicationStatus` to `AdminApplicationListProvider`

**Files:**
- Modify: `apps/server/src/App/Admission/Api/State/AdminApplicationListProvider.php`

**Context:** `ApplicationStatusRule::determine()` takes 7 arguments derived from the application entity. The `interviewScheduledFormatted` argument is rule-internal (used in display text only); the API response keeps `interviewScheduled` as ISO 8601. The new `applicationStatus` key holds the integer from `$status->getStep()`.

- [ ] **Step 1: Add constructor parameter**

In `apps/server/src/App/Admission/Api/State/AdminApplicationListProvider.php`, add the import and constructor parameter:

```php
use App\Admission\Domain\Rules\ApplicationStatusRule;
```

Add to the constructor (after `private readonly RequestStack $requestStack`):

```php
private readonly ApplicationStatusRule $applicationStatusRule,
```

Symfony autowiring resolves `ApplicationStatusRule` automatically — no service config changes needed.

- [ ] **Step 2: Update `mapApplication()` to include `applicationStatus`**

Replace the current `mapApplication()` method:

```php
private function mapApplication(Application $app): array
{
    $user = $app->getUser();
    $interview = $app->getInterview();
    $interviewer = $interview?->getInterviewer();

    $status = $this->applicationStatusRule->determine(
        isActiveAssistant: $user->isActiveAssistant(),
        hasBeenAssistant: $app->getPreviousParticipation(),
        hasInterview: $interview !== null,
        isInterviewed: $interview?->getInterviewed() ?? false,
        interviewStatus: $interview?->getInterviewStatus(),
        interviewRoom: $interview?->getRoom(),
        interviewScheduledFormatted: $interview?->getScheduled()?->format('d.m.Y H:i'),
    );

    return [
        'id' => $app->getId(),
        'userName' => $user->getFirstName().' '.$user->getLastName(),
        'userEmail' => $user->getEmail(),
        'applicationStatus' => $status->getStep(),
        'interviewStatus' => $interview?->getInterviewStatusAsString(),
        'interviewScheduled' => $interview?->getScheduled()?->format('c'),
        'interviewer' => $interviewer !== null ? $interviewer->getFirstName().' '.$interviewer->getLastName() : null,
        'previousParticipation' => $app->getPreviousParticipation(),
    ];
}
```

- [ ] **Step 3: Clear cache and verify the container compiles**

Run: `cd apps/server && php bin/console cache:clear`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/App/Admission/Api/State/AdminApplicationListProvider.php
git commit -m "feat(admission): add computed applicationStatus to AdminApplicationListProvider

Injects ApplicationStatusRule and evaluates per-application status in
mapApplication(), exposing it as 'applicationStatus' (int) in the response."
```

---

### Task 2: Unit test status computation in `AdminApplicationListProvider`

**Files:**
- Create: `apps/server/tests/App/Admission/Api/State/AdminApplicationListProviderTest.php`

**Context:** The provider is tested in isolation using PHPUnit mocks — no database needed. `ApplicationStatusRule` is tested separately; here we only verify the provider wires inputs correctly and the output array includes the `applicationStatus` key with the expected value. The `Application`, `Interview`, and `User` entities need mocking.

- [ ] **Step 1: Write the test**

```php
<?php

declare(strict_types=1);

namespace App\Tests\App\Admission\Api\State;

use ApiPlatform\Metadata\Get;
use App\Admission\Api\Resource\AdminApplicationListResource;
use App\Admission\Api\State\AdminApplicationListProvider;
use App\Admission\Domain\Rules\ApplicationStatusRule;
use App\Admission\Domain\ValueObjects\ApplicationStatus;
use App\Admission\Infrastructure\Entity\Application;
use App\Admission\Infrastructure\Repository\AdmissionPeriodRepository;
use App\Admission\Infrastructure\Repository\ApplicationRepository;
use App\Identity\Infrastructure\AccessControlService;
use App\Identity\Infrastructure\Entity\User;
use App\Interview\Infrastructure\Entity\Interview;
use App\Organization\Infrastructure\Entity\Department;
use App\Organization\Infrastructure\Repository\DepartmentRepository;
use App\Shared\Repository\SemesterRepository;
use App\Shared\Infrastructure\Entity\Semester;
use App\Admission\Infrastructure\Entity\AdmissionPeriod;
use PHPUnit\Framework\TestCase;
use Symfony\Bundle\SecurityBundle\Security;
use Symfony\Component\HttpFoundation\InputBag;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\RequestStack;

class AdminApplicationListProviderTest extends TestCase
{
    private function makeProvider(
        ApplicationRepository $appRepo,
        ApplicationStatusRule $rule,
        ?User $user = null,
        string $status = 'new',
    ): AdminApplicationListProvider {
        $department = $this->createMock(Department::class);
        $semester = $this->createMock(Semester::class);
        $admissionPeriod = $this->createMock(AdmissionPeriod::class);

        if ($user === null) {
            $user = $this->createMock(User::class);
        }
        $user->method('getDepartment')->willReturn($department);

        $security = $this->createMock(Security::class);
        $security->method('getUser')->willReturn($user);

        $accessControl = $this->createMock(AccessControlService::class);

        $semesterRepo = $this->createMock(SemesterRepository::class);
        $semesterRepo->method('findOrCreateCurrentSemester')->willReturn($semester);

        $admissionPeriodRepo = $this->createMock(AdmissionPeriodRepository::class);
        $admissionPeriodRepo->method('findOneByDepartmentAndSemester')
            ->willReturn($admissionPeriod);

        $departmentRepo = $this->createMock(DepartmentRepository::class);

        $request = $this->createMock(Request::class);
        $queryBag = $this->createMock(InputBag::class);
        $queryBag->method('get')->willReturnMap([
            ['status', 'new', $status],
            ['department', null, null],
            ['semester', null, null],
        ]);
        $request->query = $queryBag;

        $requestStack = $this->createMock(RequestStack::class);
        $requestStack->method('getCurrentRequest')->willReturn($request);

        return new AdminApplicationListProvider(
            $accessControl,
            $security,
            $appRepo,
            $admissionPeriodRepo,
            $departmentRepo,
            $semesterRepo,
            $requestStack,
            $rule,
        );
    }

    public function testApplicationItemIncludesApplicationStatusKey(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getFirstName')->willReturn('Ola');
        $user->method('getLastName')->willReturn('Normann');
        $user->method('getEmail')->willReturn('ola@example.com');
        $user->method('isActiveAssistant')->willReturn(false);
        $user->method('getDepartment')->willReturn($this->createMock(Department::class));

        $app = $this->createMock(Application::class);
        $app->method('getId')->willReturn(42);
        $app->method('getUser')->willReturn($user);
        $app->method('getInterview')->willReturn(null);
        $app->method('getPreviousParticipation')->willReturn(false);

        $appRepo = $this->createMock(ApplicationRepository::class);
        $appRepo->method('findNewApplicationsByAdmissionPeriod')->willReturn([$app]);

        $applicationStatus = new ApplicationStatus(ApplicationStatus::APPLICATION_RECEIVED, 'Søknad mottatt', 'Vent');
        $rule = $this->createMock(ApplicationStatusRule::class);
        $rule->method('determine')->willReturn($applicationStatus);

        $provider = $this->makeProvider($appRepo, $rule, $user);
        $result = $provider->provide(new Get(), []);

        $this->assertInstanceOf(AdminApplicationListResource::class, $result);
        $this->assertCount(1, $result->applications);
        $this->assertArrayHasKey('applicationStatus', $result->applications[0]);
        $this->assertSame(ApplicationStatus::APPLICATION_RECEIVED, $result->applications[0]['applicationStatus']);
    }

    public function testApplicationStatusIsAssignedToSchoolWhenUserIsActiveAssistant(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getFirstName')->willReturn('Kari');
        $user->method('getLastName')->willReturn('Hansen');
        $user->method('getEmail')->willReturn('kari@example.com');
        $user->method('isActiveAssistant')->willReturn(true);
        $user->method('getDepartment')->willReturn($this->createMock(Department::class));

        $app = $this->createMock(Application::class);
        $app->method('getId')->willReturn(1);
        $app->method('getUser')->willReturn($user);
        $app->method('getInterview')->willReturn(null);
        $app->method('getPreviousParticipation')->willReturn(false);

        $appRepo = $this->createMock(ApplicationRepository::class);
        $appRepo->method('findNewApplicationsByAdmissionPeriod')->willReturn([$app]);

        // Use real rule to verify the full integration
        $rule = new ApplicationStatusRule();

        $provider = $this->makeProvider($appRepo, $rule, $user);
        $result = $provider->provide(new Get(), []);

        $this->assertSame(ApplicationStatus::ASSIGNED_TO_SCHOOL, $result->applications[0]['applicationStatus']);
    }

    public function testApplicationStatusIsInvitedToInterviewWhenInterviewPending(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getFirstName')->willReturn('Per');
        $user->method('getLastName')->willReturn('Olsen');
        $user->method('getEmail')->willReturn('per@example.com');
        $user->method('isActiveAssistant')->willReturn(false);
        $user->method('getDepartment')->willReturn($this->createMock(Department::class));

        // InterviewStatusType::PENDING = 0
        $interview = $this->createMock(Interview::class);
        $interview->method('getInterviewed')->willReturn(false);
        $interview->method('getInterviewStatus')->willReturn(0); // PENDING
        $interview->method('getInterviewStatusAsString')->willReturn('pending');
        $interview->method('getScheduled')->willReturn(null);
        $interview->method('getRoom')->willReturn(null);
        $interview->method('getInterviewer')->willReturn(null);

        $app = $this->createMock(Application::class);
        $app->method('getId')->willReturn(2);
        $app->method('getUser')->willReturn($user);
        $app->method('getInterview')->willReturn($interview);
        $app->method('getPreviousParticipation')->willReturn(false);

        $appRepo = $this->createMock(ApplicationRepository::class);
        $appRepo->method('findNewApplicationsByAdmissionPeriod')->willReturn([$app]);

        $rule = new ApplicationStatusRule();

        $provider = $this->makeProvider($appRepo, $rule, $user);
        $result = $provider->provide(new Get(), []);

        $this->assertSame(ApplicationStatus::INVITED_TO_INTERVIEW, $result->applications[0]['applicationStatus']);
    }

    public function testApplicationStatusIsApplicationReceivedWhenNoInterview(): void
    {
        $user = $this->createMock(User::class);
        $user->method('getFirstName')->willReturn('Lise');
        $user->method('getLastName')->willReturn('Berg');
        $user->method('getEmail')->willReturn('lise@example.com');
        $user->method('isActiveAssistant')->willReturn(false);
        $user->method('getDepartment')->willReturn($this->createMock(Department::class));

        $app = $this->createMock(Application::class);
        $app->method('getId')->willReturn(3);
        $app->method('getUser')->willReturn($user);
        $app->method('getInterview')->willReturn(null);
        $app->method('getPreviousParticipation')->willReturn(false);

        $appRepo = $this->createMock(ApplicationRepository::class);
        $appRepo->method('findNewApplicationsByAdmissionPeriod')->willReturn([$app]);

        $rule = new ApplicationStatusRule();

        $provider = $this->makeProvider($appRepo, $rule, $user);
        $result = $provider->provide(new Get(), []);

        $this->assertSame(ApplicationStatus::APPLICATION_RECEIVED, $result->applications[0]['applicationStatus']);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails (method doesn't exist yet)**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/Admission/Api/State/AdminApplicationListProviderTest.php --no-coverage`
Expected: FAIL — `ApplicationStatusRule` not in constructor, or test passes on failing assertion. Proceed to Task 1 first if not done.

- [ ] **Step 3: Run the test after Task 1 is done**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit tests/App/Admission/Api/State/AdminApplicationListProviderTest.php --no-coverage`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/App/Admission/Api/State/AdminApplicationListProviderTest.php
git commit -m "test(admission): unit tests for applicationStatus computation in AdminApplicationListProvider"
```

---

### Task 3: Run regression check

- [ ] **Step 1: Run the full test suite**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit --no-coverage > /tmp/phpunit-application-review.txt 2>&1 && tail -5 /tmp/phpunit-application-review.txt`
Expected: All tests pass. If >50% fail, check fixture loading — constructor argument order matters for Symfony's autowiring test container.

- [ ] **Step 2: Run PHPStan**

Run: `cd apps/server && composer analyse`
Expected: 0 errors above baseline.

---

## Chunk 2: SDK Regeneration

### Task 4: Regenerate SDK types

**Files:**
- Modify: `packages/sdk/openapi.json`
- Modify: `packages/sdk/generated/api.d.ts`

**Context:** The `AdminApplicationListResource.applications` array items now include `applicationStatus: int`. Because the property is untyped `array` in PHP, API Platform will expose it as `array` in the schema. The generated TypeScript will type it as `object` or `unknown[]`. After regen, verify the `applicationStatus` field is visible so the frontend can consume it.

- [ ] **Step 1: Export the OpenAPI spec**

Run: `cd apps/server && php bin/console api:openapi:export --output=../../packages/sdk/openapi.json`
Expected: File updated.

- [ ] **Step 2: Regenerate TypeScript types**

Run: `cd packages/sdk && bun run generate`
Expected: `generated/api.d.ts` updated.

- [ ] **Step 3: Build the SDK**

Run: `cd packages/sdk && bun run build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/openapi.json packages/sdk/generated/api.d.ts
git commit -m "chore(sdk): regenerate types for applicationStatus field in application list"
```

---

## Chunk 3: Frontend — Application Review Page

### Task 5: Rewrite `dashboard.sokere._index.tsx`

**Files:**
- Modify: `apps/dashboard/app/routes/dashboard.sokere._index.tsx`

**Context:** Full rewrite of the stub. The current file uses a hardcoded `DataSokere` mock array with a different shape. The new file introduces: a loader with `?status` forwarding, an action with `intent=assign` and `intent=delete`, status filter tabs, a DataTable with status badges, an "Assign Interview" dialog (shadcn `Dialog` — already present at `apps/dashboard/app/components/ui/dialog.tsx`), and a delete confirmation (`AlertDialog` — already present). The mutation pattern (fetcher.submit → action → SDK → revalidation) mirrors `dashboard.utlegg._index.tsx`.

- [ ] **Step 1: Write the complete route file**

```tsx
import { DataTable } from "@/components/data-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ColumnDef } from "@tanstack/react-table";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.sokere._index";

// ── Types ────────────────────────────────────────────────────────────────────

type Application = {
  id: number;
  userName: string;
  userEmail: string;
  applicationStatus: number;
  interviewStatus: string | null;
  interviewScheduled: string | null;
  interviewer: string | null;
  previousParticipation: boolean;
};

type AdminApplicationListData = {
  status: string;
  applications: Application[];
};

// ── Mock data ─────────────────────────────────────────────────────────────────

const mockApplications: Application[] = [
  { id: 1, userName: "Ola Normann", userEmail: "ola@example.com", applicationStatus: 1, interviewStatus: null, interviewScheduled: null, interviewer: null, previousParticipation: false },
  { id: 2, userName: "Kari Hansen", userEmail: "kari@example.com", applicationStatus: 2, interviewStatus: "Pending", interviewScheduled: "2026-04-10T12:00:00+02:00", interviewer: null, previousParticipation: false },
  { id: 3, userName: "Per Olsen", userEmail: "per@example.com", applicationStatus: 3, interviewStatus: "Accepted", interviewScheduled: "2026-04-11T14:00:00+02:00", interviewer: "Jonas Berg", previousParticipation: false },
  { id: 4, userName: "Lise Berg", userEmail: "lise@example.com", applicationStatus: 4, interviewStatus: "Interviewed", interviewScheduled: "2026-04-08T10:00:00+02:00", interviewer: "Jonas Berg", previousParticipation: false },
  { id: 5, userName: "Ida Vik", userEmail: "ida@example.com", applicationStatus: 5, interviewStatus: null, interviewScheduled: null, interviewer: null, previousParticipation: true },
  { id: 6, userName: "Bjørn Lund", userEmail: "bjorn@example.com", applicationStatus: -1, interviewStatus: "Cancelled", interviewScheduled: null, interviewer: null, previousParticipation: false },
];

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) {
    return { data: { status: "all", applications: mockApplications } as AdminApplicationListData, activeFilter: "all" };
  }

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  const { data } = await client.GET("/api/admin/applications", {
    params: { query: status ? { status } : {} },
  });

  return { data: (data as AdminApplicationListData) ?? null, activeFilter: status ?? "all" };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  if (intent === "assign") {
    const applicationId = Number(form.get("applicationId"));
    const interviewerId = Number(form.get("interviewerId"));
    const interviewSchemaId = Number(form.get("interviewSchemaId"));

    const { error } = await client.POST("/api/admin/interviews/assign", {
      body: { applicationId, interviewerId, interviewSchemaId },
    });

    if (error) return { error: "Kunne ikke tildele intervju" };
    return { success: true };
  }

  if (intent === "delete") {
    const applicationId = form.get("applicationId")?.toString();
    const { error } = await client.DELETE("/api/admin/applications/{id}", {
      params: { path: { id: applicationId! } },
    });
    if (error) return { error: "Kunne ikke slette søknad" };
    return { success: true };
  }

  return { error: "Unknown intent" };
}

// ── Status badge ──────────────────────────────────────────────────────────────

const applicationStatusMeta: Record<number, { label: string; className: string }> = {
  [-1]: { label: "Kansellert", className: "bg-red-100 text-red-800" },
  [0]: { label: "Ikke mottatt", className: "bg-gray-100 text-gray-700" },
  [1]: { label: "Søknad mottatt", className: "bg-blue-100 text-blue-800" },
  [2]: { label: "Invitert", className: "bg-yellow-100 text-yellow-800" },
  [3]: { label: "Tidspunkt godtatt", className: "bg-orange-100 text-orange-800" },
  [4]: { label: "Intervju gjennomført", className: "bg-green-100 text-green-800" },
  [5]: { label: "Tatt opp", className: "bg-emerald-100 text-emerald-800" },
};

function ApplicationStatusBadge({ status }: { status: number }) {
  const meta = applicationStatusMeta[status] ?? { label: String(status), className: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  );
}

// ── Interview assignment dialog ───────────────────────────────────────────────

type UserOption = { id: number; firstName: string; lastName: string; role: string };
type SchemaOption = { id: number; name: string };

function AssignInterviewDialog({
  application,
  open,
  onOpenChange,
}: {
  application: Application;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fetcher = useFetcher();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [schemas, setSchemas] = useState<SchemaOption[]>([]);
  const [interviewerId, setInterviewerId] = useState<string>("");
  const [schemaId, setSchemaId] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Fetch options when dialog opens
  const handleOpenChange = async (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) return;

    setLoading(true);
    try {
      // These calls use the same authenticated client from the server loader.
      // In the browser, we rely on cookie/session auth. If the SDK client is
      // not available client-side, use useFetcher loaders instead.
      const [usersResp, schemasResp] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/interview-schemas", { credentials: "include" }),
      ]);

      if (usersResp.ok) {
        const usersData = await usersResp.json();
        // Endpoint returns { activeUsers: [...], inactiveUsers: [...] } (not Hydra)
        const activeUsers: UserOption[] = (usersData?.activeUsers ?? []) as UserOption[];
        const eligible = activeUsers.filter(
          (u) => u.role === "ROLE_TEAM_LEADER" || u.role === "ROLE_ADMIN",
        );
        setUsers(eligible);
      }

      if (schemasResp.ok) {
        const schemasData = await schemasResp.json();
        // Endpoint returns Hydra collection
        const members = (schemasData?.["hydra:member"] ?? []) as SchemaOption[];
        setSchemas(members);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    if (!interviewerId || !schemaId) return;
    fetcher.submit(
      {
        intent: "assign",
        applicationId: String(application.id),
        interviewerId,
        interviewSchemaId: schemaId,
      },
      { method: "post" },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tildel intervju — {application.userName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Laster...</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Intervjuer</label>
              <Select value={interviewerId} onValueChange={setInterviewerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Velg intervjuer" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.firstName} {u.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Intervjuskjema</label>
              <Select value={schemaId} onValueChange={setSchemaId}>
                <SelectTrigger>
                  <SelectValue placeholder="Velg skjema" />
                </SelectTrigger>
                <SelectContent>
                  {schemas.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!interviewerId || !schemaId || fetcher.state !== "idle"}
          >
            Tildel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Actions cell ──────────────────────────────────────────────────────────────

function ActionsCell({ application }: { application: Application }) {
  const [assignOpen, setAssignOpen] = useState(false);
  const fetcher = useFetcher();

  return (
    <div className="flex gap-2">
      {application.interviewer === null && (
        <>
          <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
            <UserPlus className="h-4 w-4" />
            <span className="ml-1">Tildel intervju</span>
          </Button>
          <AssignInterviewDialog
            application={application}
            open={assignOpen}
            onOpenChange={setAssignOpen}
          />
        </>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm" disabled={fetcher.state !== "idle"}>
            <Trash2 className="h-4 w-4" />
            <span className="ml-1">Slett</span>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Slett søknad</AlertDialogTitle>
            <AlertDialogDescription>
              Er du sikker på at du vil slette søknaden til {application.userName}? Dette kan ikke angres.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                fetcher.submit(
                  { intent: "delete", applicationId: String(application.id) },
                  { method: "post" },
                );
              }}
            >
              Slett
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Columns ───────────────────────────────────────────────────────────────────

const columns: ColumnDef<Application>[] = [
  { accessorKey: "userName", header: "Navn" },
  { accessorKey: "userEmail", header: "E-post" },
  {
    accessorKey: "applicationStatus",
    header: "Status",
    cell: ({ row }) => <ApplicationStatusBadge status={row.original.applicationStatus} />,
  },
  {
    accessorKey: "interviewStatus",
    header: "Intervjustatus",
    cell: ({ row }) => row.original.interviewStatus ?? "—",
  },
  {
    accessorKey: "interviewer",
    header: "Intervjuer",
    cell: ({ row }) => row.original.interviewer ?? "—",
  },
  {
    accessorKey: "interviewScheduled",
    header: "Tidspunkt",
    cell: ({ row }) => {
      const iso = row.original.interviewScheduled;
      if (!iso) return "—";
      return new Date(iso).toLocaleString("nb-NO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
  },
  {
    id: "actions",
    header: "Handlinger",
    cell: ({ row }) => <ActionsCell application={row.original} />,
  },
];

// ── Filter tabs ───────────────────────────────────────────────────────────────

const statusFilters = [
  { value: null, label: "Alle" },
  { value: "new", label: "Nye" },
  { value: "assigned", label: "Tildelt" },
  { value: "interviewed", label: "Intervjuet" },
  { value: "existing", label: "Eksisterende" },
] as const;

// ── Page component ────────────────────────────────────────────────────────────

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Sokere() {
  const { data, activeFilter } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const applications = data?.applications ?? [];

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-6 font-semibold text-2xl">Søkere</h1>

      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex gap-2">
          {statusFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={activeFilter === (filter.value ?? "all") ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (filter.value === null) {
                  setSearchParams({});
                } else {
                  setSearchParams({ status: filter.value });
                }
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {applications.length === 0 ? (
          <DataTable columns={columns} data={[]} />
        ) : (
          <DataTable columns={columns} data={applications} />
        )}
      </div>
    </section>
  );
}
```

**Implementation notes:**
- The assignment dialog fetches user/schema options via direct `fetch()` calls on dialog open. This keeps the loader lean (no pre-fetching data the user may never need) and avoids SSR complications. If the API requires a JWT header (not cookie), switch to `useFetcher` with a resource route that wraps the SDK calls.
- The `activeFilter` comparison handles the "Alle" tab: when no `?status` param is present, `activeFilter` is `"all"` and `filter.value ?? "all"` evaluates to `"all"` for the null entry.
- `interviewScheduled` is ISO 8601 from the API; `toLocaleString("nb-NO")` formats it for display, matching the spec's requirement that the API returns ISO and the frontend formats.

- [ ] **Step 2: Check for Select component**

Run: `ls apps/dashboard/app/components/ui/select.tsx`
If missing, add via shadcn CLI:
```bash
cd apps/dashboard && bunx shadcn@latest add select
```

- [ ] **Step 3: Run typecheck**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors. If the SDK types for `/api/admin/interviews/assign` or `/api/admin/applications/{id}` are missing, cast with `as any` and add a comment to revisit after full SDK regen.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/app/routes/dashboard.sokere._index.tsx
git commit -m "feat(dashboard): application review page with status badges, filter tabs, and interview assignment

Rewrites the stub with:
- Loader forwarding ?status filter to GET /api/admin/applications
- Action handling intent=assign (POST /api/admin/interviews/assign) and intent=delete
- DataTable with applicationStatus badges and Norwegian labels
- Status filter tabs (Alle / Nye / Tildelt / Intervjuet / Eksisterende)
- Interview assignment dialog fetching users and schemas on open
- Delete confirmation via AlertDialog"
```

---

## Chunk 4: End-to-End Verification

### Task 6: Verify end-to-end

- [ ] **Step 1: Run the full PHP test suite**

Run: `cd apps/server && php -d memory_limit=512M bin/phpunit --no-coverage > /tmp/phpunit-final-sokere.txt 2>&1 && tail -5 /tmp/phpunit-final-sokere.txt`
Expected: All tests pass. If >50% fail, suspect a constructor argument order issue — check `AdminApplicationListProvider` constructor matches Symfony's autowiring sequence.

- [ ] **Step 2: Run PHPStan**

Run: `cd apps/server && composer analyse`
Expected: 0 errors above baseline.

- [ ] **Step 3: Run dashboard typecheck**

Run: `cd apps/dashboard && bunx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Verify fixture mode renders correctly**

Run: `cd apps/dashboard && bun run dev`
Navigate to `/dashboard/sokere`. In fixture mode:
- Table should show 6 rows covering all 7 `applicationStatus` values (including cancelled at -1)
- Status badges should render with correct colors and Norwegian labels
- "Tildel intervju" button should appear only for rows where `interviewer === null`
- "Slett" button should appear for all rows
- Status filter tabs should change the `?status` URL param

- [ ] **Step 5: Final commit if any adjustments were needed**

Only if steps 1–3 revealed issues that needed fixing.
