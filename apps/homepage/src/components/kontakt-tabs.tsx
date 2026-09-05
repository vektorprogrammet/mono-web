import { CONTACT_LIMITS } from "@vektorprogrammet/domain/contact";
import type { DepartmentJson } from "@vektorprogrammet/domain/organization";
import { useState } from "react";
import { Mail, MapPin } from "lucide-react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { type ContactActionData, contactDepartmentSlug } from "~/lib/contact-message";

export function ContactTabs({
  department,
  departments,
}: {
  readonly department: DepartmentJson;
  readonly departments: readonly DepartmentJson[];
}) {
  const actionData = useActionData<ContactActionData>();
  // Each action result is a new identity. Only acceptance replaces the uncontrolled draft.
  const [draft, setDraft] = useState({ result: actionData, generation: 0 });
  if (draft.result !== actionData) {
    setDraft({ result: actionData, generation: draft.generation + (actionData?.ok ? 1 : 0) });
  }
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <div className="mb-6 flex w-full flex-col gap-8 px-5 md:max-w-6xl lg:flex-row">
      <nav aria-label="Velg avdeling" className="flex min-w-48 flex-wrap gap-2 lg:flex-col">
        {departments.map((item) => {
          const selected = item.departmentId === department.departmentId;
          return (
            <Button asChild variant={selected ? "default" : "outline"} key={item.departmentId}>
              <Link
                to={`/kontakt/${contactDepartmentSlug(item)}`}
                aria-current={selected ? "page" : undefined}
              >
                {item.shortName}
              </Link>
            </Button>
          );
        })}
      </nav>
      <main className="w-full min-w-0">
        <section className="grid w-full grid-cols-1 gap-8 rounded-md border p-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className="font-bold text-2xl text-blue-800 dark:text-neutral-200">
              {department.name}
            </h2>
            <div className="mt-5 flex items-center gap-2">
              <Mail aria-hidden className="h-5 w-5" />
              <a className="break-all hover:underline" href={`mailto:${department.email}`}>
                {department.email}
              </a>
            </div>
            {department.address && (
              <div className="mt-3 flex gap-2">
                <MapPin aria-hidden className="h-5 w-5 shrink-0" />
                <span>{department.address}</span>
              </div>
            )}
            <p className="mt-3">{department.city}</p>
          </div>
          <div className="min-w-0">
            <h2 className="font-bold text-2xl text-blue-800 dark:text-neutral-200">
              {`Kontakt ${department.shortName}`}
            </h2>
            <Form method="post" className="mt-5" key={draft.generation}>
              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="contact-name">Ditt navn</Label>
                  <Input
                    id="contact-name"
                    name="name"
                    maxLength={CONTACT_LIMITS.name}
                    autoComplete="name"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="contact-email">Din e-post</Label>
                  <Input
                    id="contact-email"
                    name="email"
                    maxLength={CONTACT_LIMITS.email}
                    type="email"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>
              <div className="mt-5">
                <Label htmlFor="contact-subject">Emne</Label>
                <Input
                  id="contact-subject"
                  name="subject"
                  maxLength={CONTACT_LIMITS.subject}
                  required
                />
              </div>
              <div className="mt-5">
                <Label htmlFor="contact-message">Melding</Label>
                <Textarea
                  id="contact-message"
                  name="message"
                  rows={6}
                  maxLength={CONTACT_LIMITS.message}
                  required
                />
              </div>
              <Button className="mt-5" type="submit" disabled={submitting}>
                {submitting ? "Sender melding..." : "Send melding"}
              </Button>
              {!submitting && actionData?.ok && (
                <p className="mt-4 rounded-md bg-green-100 p-3 text-green-900" role="status">
                  Meldingen er sendt.
                </p>
              )}
              {!submitting && actionData && !actionData.ok && (
                <p className="mt-4 rounded-md bg-red-100 p-3 text-red-900" role="alert">
                  {actionData.message}
                </p>
              )}
            </Form>
          </div>
        </section>
      </main>
    </div>
  );
}
