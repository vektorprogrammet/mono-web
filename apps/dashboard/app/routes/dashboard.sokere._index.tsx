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
import type { Application } from "@vektorprogrammet/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  redirect,
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";
import {
  isUnauthorizedApplicantError,
  mapApplicantError,
  projectInterviewerOption,
  projectSchemaOption,
  type ApplicantInterviewerOption,
  type ApplicantSchemaOption,
} from "../lib/applicant-view";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.sokere._index";

type LoaderData =
  | {
      ok: true;
      applications: Application[];
      activeFilter: string;
      users: ApplicantInterviewerOption[];
      schemas: ApplicantSchemaOption[];
    }
  | {
      ok: false;
      activeFilter: string;
      error: string;
    };

type ActionData =
  | { success: true }
  | { error: string; type?: "validation" | "sdk" };

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs): Promise<LoaderData> {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const activeFilter = status ?? "all";

  const [applications, users, schemas] = await Promise.all([
    client.admin.applications.list(status ? { status } : undefined).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error,
        context: "applications" as const,
      }),
    ),
    client.admin.users.list().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error,
        context: "options" as const,
      }),
    ),
    client.admin.interviews.schemas().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        error,
        context: "options" as const,
      }),
    ),
  ]);

  if (
    (!applications.ok && isUnauthorizedApplicantError(applications.error)) ||
    (!users.ok && isUnauthorizedApplicantError(users.error)) ||
    (!schemas.ok && isUnauthorizedApplicantError(schemas.error))
  ) {
    throw redirect("/login?expired=true");
  }
  if (!applications.ok) {
    return {
      ok: false,
      activeFilter,
      error: mapApplicantError(applications.error, applications.context),
    };
  }
  if (!users.ok) {
    return {
      ok: false,
      activeFilter,
      error: mapApplicantError(users.error, users.context),
    };
  }
  if (!schemas.ok) {
    return {
      ok: false,
      activeFilter,
      error: mapApplicantError(schemas.error, schemas.context),
    };
  }
  return {
    ok: true,
    applications: applications.value.items,
    activeFilter,
    users: users.value.active
      .filter(
        (user) =>
          user.role === "ROLE_TEAM_LEADER" || user.role === "ROLE_ADMIN",
      )
      .map(projectInterviewerOption),
    schemas: schemas.value.map(projectSchemaOption),
  };
}

export function shouldRevalidate({
  actionResult,
  defaultShouldRevalidate,
}: {
  actionResult?: unknown;
  defaultShouldRevalidate: boolean;
}): boolean {
  if (
    actionResult !== null &&
    typeof actionResult === "object" &&
    "type" in actionResult
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

// ── Action ────────────────────────────────────────────────────────────────────

function parsePositiveInteger(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

export async function action({ request }: Route.ActionArgs): Promise<ActionData> {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  if (intent === "assign") {
    const applicationId = parsePositiveInteger(form.get("applicationId"));
    const interviewerId = parsePositiveInteger(form.get("interviewerId"));
    const interviewSchemaId = parsePositiveInteger(form.get("interviewSchemaId"));

    if (applicationId === null || interviewerId === null || interviewSchemaId === null) {
      return {
        error: "Ugyldig søknad, intervjuer eller intervjuskjema.",
        type: "validation",
      };
    }

    try {
      await client.admin.interviews.assign(
        applicationId,
        interviewerId,
        interviewSchemaId,
      );
      return { success: true };
    } catch (error) {
      if (isUnauthorizedApplicantError(error)) {
        throw redirect("/login?expired=true");
      }
      return {
        error: mapApplicantError(error, "assignment"),
        type: "sdk",
      };
    }
  }

  if (intent === "delete") {
    const applicationId = form.get("applicationId")?.toString();
    try {
      await client.admin.applications.delete(Number(applicationId));
      return { success: true };
    } catch {
      return { error: "Kunne ikke slette søknad" };
    }
  }

  return { error: "Unknown intent" };
}


// ── Status badge ──────────────────────────────────────────────────────────────

const applicationStatusMeta: Record<string, { label: string; className: string }> = {
  cancelled: { label: "Avbrutt", className: "bg-red-100 text-red-800" },
  not_received: { label: "Ikke mottatt", className: "bg-gray-100 text-gray-700" },
  received: { label: "Mottatt", className: "bg-blue-100 text-blue-800" },
  invited: { label: "Invitert", className: "bg-yellow-100 text-yellow-800" },
  accepted: { label: "Akseptert", className: "bg-orange-100 text-orange-800" },
  completed: { label: "Fullført", className: "bg-green-100 text-green-800" },
  assigned: { label: "Tildelt skole", className: "bg-emerald-100 text-emerald-800" },
};

function ApplicationStatusBadge({ status }: { status: string }) {
  const meta = applicationStatusMeta[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.label}
    </span>
  );
}

// ── Interview assignment dialog ───────────────────────────────────────────────

function AssignInterviewDialog({
  application,
  users,
  schemas,
  open,
  onOpenChange,
}: {
  application: Application;
  users: ApplicantInterviewerOption[];
  schemas: ApplicantSchemaOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const [interviewerId, setInterviewerId] = useState<string>("");
  const [schemaId, setSchemaId] = useState<string>("");
  const error =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;

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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tildel intervju — {application.userName}</DialogTitle>
        </DialogHeader>

        {error && (
          <p className="rounded bg-red-50 p-2 text-red-600 text-sm" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Intervjuer</label>
            <Select value={interviewerId} onValueChange={setInterviewerId}>
              <SelectTrigger>
                <SelectValue placeholder="Velg intervjuer" />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user.id} value={String(user.id)}>
                    {user.firstName} {user.lastName}
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
                {schemas.map((schema) => (
                  <SelectItem key={schema.id} value={String(schema.id)}>
                    {schema.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

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

function ActionsCell({
  application,
  users,
  schemas,
}: {
  application: Application;
  users: ApplicantInterviewerOption[];
  schemas: ApplicantSchemaOption[];
}) {
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
          {assignOpen && (
            <AssignInterviewDialog
              application={application}
              users={users}
              schemas={schemas}
              open={assignOpen}
              onOpenChange={setAssignOpen}
            />
          )}
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

function createColumns(
  users: ApplicantInterviewerOption[],
  schemas: ApplicantSchemaOption[],
): ColumnDef<Application>[] {
  return [
    { accessorKey: "userName", header: "Navn" },
    { accessorKey: "userEmail", header: "E-post" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <ApplicationStatusBadge status={row.original.status} />,
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
      cell: ({ row }) => (
        <ActionsCell application={row.original} users={users} schemas={schemas} />
      ),
    },
  ];
}

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
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const users = data.ok ? data.users : undefined;
  const schemas = data.ok ? data.schemas : undefined;
  const columns = useMemo(
    () => createColumns(users ?? [], schemas ?? []),
    [users, schemas],
  );

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-6 font-semibold text-2xl">Søkere</h1>

      <div className="w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex gap-2">
          {statusFilters.map((filter) => (
            <Button
              key={filter.label}
              variant={
                data.activeFilter === (filter.value ?? "all")
                  ? "default"
                  : "outline"
              }
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

        {data.ok ? (
          <DataTable
            columns={columns}
            data={data.applications}
          />
        ) : (
          <p className="rounded bg-red-50 p-3 text-red-600 text-sm" role="alert">
            {data.error}
          </p>
        )}
      </div>
    </section>
  );
}
