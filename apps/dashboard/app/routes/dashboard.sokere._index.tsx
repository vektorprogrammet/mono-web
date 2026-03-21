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

// ── Types ─────────────────────────────────────────────────────────────────────

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

  const { data } = await client.GET("/api/admin/applications" as any, {
    params: { query: status ? { status } : {} },
  });

  return { data: (data as unknown as AdminApplicationListData) ?? null, activeFilter: status ?? "all" };
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

    const { error } = await client.POST("/api/admin/interviews/assign" as any, {
      body: { applicationId, interviewerId, interviewSchemaId },
    });

    if (error) return { error: "Kunne ikke tildele intervju" };
    return { success: true };
  }

  if (intent === "delete") {
    const applicationId = form.get("applicationId")?.toString();
    const { error } = await client.DELETE("/api/admin/applications/{id}" as any, {
      params: { path: { id: applicationId! } },
    });
    if (error) return { error: "Kunne ikke slette søknad" };
    return { success: true };
  }

  return { error: "Unknown intent" };
}

// ── Status badge ──────────────────────────────────────────────────────────────

const applicationStatusMeta: Record<number, { label: string; className: string }> = {
  [-1]: { label: "Avbrutt", className: "bg-red-100 text-red-800" },
  [0]: { label: "Ikke mottatt", className: "bg-gray-100 text-gray-700" },
  [1]: { label: "Mottatt", className: "bg-blue-100 text-blue-800" },
  [2]: { label: "Invitert", className: "bg-yellow-100 text-yellow-800" },
  [3]: { label: "Akseptert", className: "bg-orange-100 text-orange-800" },
  [4]: { label: "Fullført", className: "bg-green-100 text-green-800" },
  [5]: { label: "Tildelt skole", className: "bg-emerald-100 text-emerald-800" },
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

  const handleOpenChange = async (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) return;

    setLoading(true);
    try {
      const [usersResp, schemasResp] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/interview-schemas", { credentials: "include" }),
      ]);

      if (usersResp.ok) {
        const usersData = await usersResp.json();
        const activeUsers: UserOption[] = (usersData?.activeUsers ?? []) as UserOption[];
        const eligible = activeUsers.filter(
          (u) => u.role === "ROLE_TEAM_LEADER" || u.role === "ROLE_ADMIN",
        );
        setUsers(eligible);
      }

      if (schemasResp.ok) {
        const schemasData = await schemasResp.json();
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

        <DataTable columns={columns} data={applications} />
      </div>
    </section>
  );
}
