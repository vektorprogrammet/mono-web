import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import { NavLink, href } from "react-router";
import { getProfileData } from "../mock/api/data-profile";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Profile() {
  const profile = getProfileData();
  return (
    <>
      <div className="mx-10 mt-10 flex flex-col">
        <section className="items-center gap-4 lg:mb-8 lg:grid lg:grid-cols-3 lg:flex-row">
          <img
            className="h-40 w-40 self-end justify-self-center rounded-full object-cover"
            alt="profilbilde"
            src={profile.profileImage}
          />
          <div className="flex flex-col items-center self-end lg:items-start">
            <h1 className="mb-2 font-semibold text-2xl lg:mb-4 lg:text-4xl">
              {profile.firstName} {profile.lastName}
            </h1>
            <h2 className="font-medium lg:text-xl">Teammedlem</h2>
            <p className="lg:mb-4">
              <a
                href={`mailto:${profile.vektorEmail}`}
                className="text-blue-600 hover:underline"
              >
                {profile.vektorEmail}
              </a>
            </p>
          </div>
        </section>
        <div className="hidden gap-8 lg:grid lg:grid-cols-3">
          <div className="col-start-2 col-end-4">
            <h2 className="mt-2 font-semibold text-xl">
              Aktivitet i vektorprogrammet
            </h2>
            {profile.boardHistory.length > 0 ? (
              <h3 className="mt-2 font-medium text-lg">Medlem i hovedstyret</h3>
            ) : (
              <h3 className="mt-2 font-medium text-lg">Teamhistorikk</h3>
            )}
          </div>
        </div>
        <div className="mb-8 gap-8 lg:grid lg:grid-cols-3 lg:flex-row">
          <div className="col-span-1 mt-8 lg:mt-0">
            <div className="flex flex-col">
              <Button
                asChild
                className="flex flex-row justify-between rounded-t-lg bg-gray-50 px-4 py-2 text-left font-medium text-black hover:bg-gray-100"
              >
                <NavLink
                  to={href("/dashboard/profile/rediger")}
                  prefetch="intent"
                >
                  Rediger profil
                  <ChevronRight />
                </NavLink>
              </Button>
              <Button
                type="button"
                className="flex flex-row justify-between rounded-b-lg bg-gray-50 px-4 py-2 text-left font-medium text-black hover:bg-gray-100"
              >
                Bytt passord
                <ChevronRight />
              </Button>
            </div>
            <Table className="mt-8 w-full table-fixed border-separate rounded-lg bg-gray-50">
              <TableBody>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">Avdeling:</TableCell>
                  <TableCell className="truncate">
                    {profile.department}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">Linje:</TableCell>
                  <TableCell className="truncate">{profile.study}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">Telefon:</TableCell>
                  <TableCell className="truncate">{profile.phone}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">E-post:</TableCell>
                  <TableCell className="truncate">
                    <a
                      className="text-blue-600 hover:underline"
                      href={`mailto:${profile.email}`}
                    >
                      {profile.email}
                    </a>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="col-span-2 max-w-3xl">
            <div className="mt-8 block lg:hidden">
              <h2 className="mt-2 font-semibold text-xl">
                Aktivitet i vektorprogrammet
              </h2>
              {profile.boardHistory.length > 0 ? (
                <h3 className="mt-4 mb-2 font-medium text-lg">
                  Medlem i hovedstyret
                </h3>
              ) : (
                <h3 className="mt-4 mb-2 font-medium text-lg">Teamhistorikk</h3>
              )}
            </div>
            {profile.boardHistory.length > 0 && (
              <>
                <Table className="w-full overflow-hidden rounded-lg bg-gray-50">
                  <TableHeader className="rounded-t-lg bg-gray-200 text-left">
                    <TableHead className="p-2 text-black">Stilling</TableHead>
                    <TableHead className="p-2 text-black">Start</TableHead>
                    <TableHead className="p-2 text-black">Slutt</TableHead>
                  </TableHeader>
                  <TableBody>
                    {profile.boardHistory.map((row) => (
                      <TableRow key={`${row.position}-${row.start}-${row.end}`}>
                        <TableCell className="p-2">{row.position}</TableCell>
                        <TableCell className="p-2">{row.start}</TableCell>
                        <TableCell className="p-2">{row.end}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <h3 className="mt-8 mb-2 font-medium text-lg">Teamhistorikk</h3>
              </>
            )}
            <Table className="w-full overflow-hidden rounded-lg bg-gray-50">
              <TableHeader className="rounded-t-lg bg-gray-200 text-left">
                <TableHead className="p-2 text-black">Team</TableHead>
                <TableHead className="p-2 text-black">Stilling</TableHead>
                <TableHead className="p-2 text-black">Start</TableHead>
                <TableHead className="p-2 text-black">Slutt</TableHead>
              </TableHeader>
              <TableBody>
                {profile.teamHistory.map((row) => (
                  <TableRow
                    key={`${row.team}-${row.position}-${row.start}-${row.end}`}
                    className="border-none"
                  >
                    <TableCell className="p-2">{row.team}</TableCell>
                    <TableCell className="p-2">{row.position}</TableCell>
                    <TableCell className="p-2">{row.start}</TableCell>
                    <TableCell className="p-2">{row.end}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <h3 className="mt-8 mb-2 font-medium text-lg">
              Assistenthistorikk
            </h3>
            <Table className="w-full overflow-hidden rounded-lg bg-gray-50">
              <TableHeader className="rounded-t-lg bg-gray-200 text-left">
                <TableHead className="p-2 text-black">Skole</TableHead>
                <TableHead className="p-2 text-black">Semester</TableHead>
              </TableHeader>
              <TableBody>
                {profile.assistantHistory.map((row) => (
                  <TableRow
                    key={`${row.school}-${row.semester}`}
                    className="border-none"
                  >
                    <TableCell className="p-2">{row.school}</TableCell>
                    <TableCell className="p-2">{row.semester}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </>
  );
}
