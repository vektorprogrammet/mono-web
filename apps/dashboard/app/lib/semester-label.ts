/** Labels a canonical semester with its Norwegian local dates instead of a storage identifier. */
export function semesterLabel(semester: { startAt: string; endAt: string }): string {
  const format = new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Oslo",
  });

  return `${format.format(new Date(semester.startAt))} – ${format.format(new Date(semester.endAt))}`;
}
