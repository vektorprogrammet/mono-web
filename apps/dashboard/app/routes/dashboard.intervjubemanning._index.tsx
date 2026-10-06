import { createElement } from "react";
import { STAFFING_ELEMENT } from "../foldkit/recruitment-maintenance/elements";
import { useLocation, useNavigation } from "react-router";

export default function Intervjubemanning() {
  const location = useLocation();
  const navigation = useNavigation();
  // A real location replacement ends the custom element's runtime immediately,
  // including while the destination loader is pending. Revalidation/fetchers do not.
  const leaving = navigation.location !== undefined && navigation.location.key !== location.key;

  return leaving ? null : createElement(STAFFING_ELEMENT, { key: location.key });
}
