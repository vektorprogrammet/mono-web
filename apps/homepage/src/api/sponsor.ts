import { DEV_CONTENT } from "~/lib/dev-content";

export type Sponsor = {
  readonly name: string;
  readonly url: URL;
};

export function getSponsors(): Sponsor[] {
  return DEV_CONTENT.sponsors.map((sponsor) => ({
    name: sponsor.name,
    url: new URL(sponsor.href),
  }));
}
