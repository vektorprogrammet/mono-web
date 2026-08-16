type AssistantHistory = {
  school: string;
  semester: string;
};

type TeamHistory = {
  team: string;
  position: string;
  start: string;
  end: string;
};

type BoardHistory = {
  position: string;
  start: string;
  end: string;
};

type Profile = {
  firstName: string;
  lastName: string;
  vektorEmail: string;
  email: string;
  phone: string;
  study: string;
  department: string;
  accountNumber: string;
  profileImage: string;
  assistantHistory: Array<AssistantHistory>;
  teamHistory: Array<TeamHistory>;
  boardHistory: Array<BoardHistory>;
};

export function getProfileData(): Profile {
  return {
    firstName: "Fixture",
    lastName: "Operator",
    vektorEmail: "operator@fixture.example.invalid",
    email: "operator@example.invalid",
    phone: "00000000",
    study: "FIXTURE",
    department: "Example",
    accountNumber: "0000 00 00000",
    profileImage: "https://assets.example.invalid/fixture/profile.svg",
    assistantHistory: [
      {
        school: "Charlottenlund",
        semester: "Vår 2023",
      },
      {
        school: "Charlottenlund",
        semester: "Høst 2022",
      },
    ],
    teamHistory: [
      {
        team: "IT",
        position: "Utvikler",
        start: "Vår 2023",
        end: "Fortsatt aktiv",
      },
    ],
    boardHistory: [
      {
        position: "Medlem",
        start: "Vår 2022",
        end: "Høst 2022",
      },
    ],
  };
}
