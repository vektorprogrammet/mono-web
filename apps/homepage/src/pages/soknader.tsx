import { getDevProfile } from "~/lib/dev-content";
// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function MineSoknader() {
  const profile = getDevProfile();
  return (
    <div className="mb-10 flex w-full justify-center">
      <div className="col-12 text-center">
        <h1 className="mt-14 pt-4 pb-2 font-medium text-4xl text-vektor-darblue md:mt-0">
          Mine Søknader
        </h1>
        <ProfileModal
          imgUrl={profile.image}
          name={profile.name}
          imageAlt={profile.imageAlt}
        />
        <Applications
          applications={[
            {
              role: "IT-leder Høst 2024",
              status: "Avslått",
              expectedAction:
                "Ingen videre handling er nødvendig. Du vil ikke bli leder for IT høsten 2024.",
            },
            {
              role: "Vektorassistent Høst 2023",
              status: "Under vurdering",
              expectedAction: "Vente på svar",
            },
            {
              role: "Vektorassistent Vår 2022",
              status: "Innvilget",
              expectedAction: "Vente på mail med videre informasjon",
            },
          ]}
        />
      </div>
    </div>
  );
}

function ProfileModal({
  imgUrl,
  name,
  imageAlt,
}: {
  imgUrl: string;
  name: string;
  imageAlt: string;
}) {
  return (
    <div>
      <div className="flex justify-center">
        <img
          src={imgUrl}
          alt={imageAlt}
          className="mt-2 w-1/2 max-w-sm rounded-full"
        />
      </div>
      <p className=" mt-2 font-medium text-gray-600 text-m">
        Du er logget inn som
      </p>
      <h2 className="pb-2 font-medium text-2xl text-vektor-darblue">{name}</h2>
    </div>
  );
}

function Applications({
  applications,
}: {
  applications: Array<{
    role: string;
    status: string;
    expectedAction: string;
  }>;
}) {
  return (
    <div className="mt-2 flex flex-col justify-center">
      {applications.map((application) => {
        return (
          <div
            key={application.toString()}
            className="mx-4 mt-4 max-w-lg rounded-sm border-2 border-gray-200 p-2 shadow-md"
          >
            <h1 className="mt-2 font-medium text-2xl text-vektor-darblue">
              {application.role}
            </h1>
            <p className="mt-2 font-medium text-gray-600 text-m">
              <span className="font-bold">Status:</span> {application.status}
            </p>
            <p className="my-2 font-medium text-gray-600 text-m">
              <span className="font-bold">Forventet Handling:</span>{" "}
              {application.expectedAction}
            </p>
          </div>
        );
      })}
    </div>
  );
}
