/**
 * The answers of the availability questions on the public application form. The form renders
 * them and its parser reads them. Only types come from the contract, so the browser bundle does
 * not import it; the parser decodes every answer through the contract schema, so a list that
 * drifts from the contract fails there.
 */
import type { SubmitApplicationRequest } from "@vektorprogrammet/http-api";
import { Struct } from "effect";

type AssistantAvailability = SubmitApplicationRequest["availability"];

/** A member that marks one weekday; true states that the day does not suit. */
export type UnavailableWeekday = Extract<keyof AssistantAvailability, `${string}Unavailable`>;

/** The value that a checked weekday box sends. An unchecked box sends no member. */
export const unavailableWeekdayValue = "true";

const weekdayLabels: Readonly<Record<UnavailableWeekday, string>> = {
  mondayUnavailable: "Mandag",
  tuesdayUnavailable: "Tirsdag",
  wednesdayUnavailable: "Onsdag",
  thursdayUnavailable: "Torsdag",
  fridayUnavailable: "Fredag",
};

/** One box per weekday, in calendar order. Each box is named by the member that it marks. */
export const weekdayOptions = Struct.keys(weekdayLabels).map((name) => ({
  name,
  label: weekdayLabels[name],
}));

/**
 * One question states the length of the position and its teaching block. It replaces the two
 * legacy questions, which disabled the block for eight weeks: an eight-week position serves both
 * blocks, so no answer states eight weeks in one block.
 */
const positionAnswers: ReadonlyArray<
  readonly [Pick<AssistantAvailability, "positionWeeks" | "preferredGroup">, string]
> = [
  [{ positionWeeks: 4, preferredGroup: "all" }, "4 uker, bolk 1 eller bolk 2"],
  [{ positionWeeks: 4, preferredGroup: "block-1" }, "4 uker, bare bolk 1"],
  [{ positionWeeks: 4, preferredGroup: "block-2" }, "4 uker, bare bolk 2"],
  [{ positionWeeks: 8, preferredGroup: "all" }, "8 uker, begge bolkene"],
];

/** The value of each answer derives from the availability that it states. */
export const positionOptions = positionAnswers.map(([availability, label]) => ({
  value: `${availability.positionWeeks}-${availability.preferredGroup}`,
  label,
  availability,
}));

/** Norsk names a Norwegian school, Engelsk an international school, and Norsk og engelsk either. */
const languageLabels: Readonly<Record<AssistantAvailability["language"], string>> = {
  Norsk: "Norsk skole",
  Engelsk: "Internasjonal skole (engelsk)",
  "Norsk og engelsk": "Begge passer",
};

/** Each answer sends the contract's language as its value. */
export const languageOptions = Struct.keys(languageLabels).map((language) => ({
  value: language,
  label: languageLabels[language],
  availability: { language },
}));
