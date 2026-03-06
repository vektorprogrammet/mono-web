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
    firstName: "Julia",
    lastName: "Dai",
    vektorEmail: "julia@vektorprogrammet.no",
    email: "julia@gmail.com",
    phone: "466 66 888",
    study: "MTDT",
    department: "IT",
    accountNumber: "0000 00 00000",
    profileImage:
      "https://vektorprogrammet.no/media/cache/profile_img/images/Profile%20photos/6407131bab385.jpeg",
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
