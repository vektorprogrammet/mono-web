import { Predicate } from "effect";
import { Match as M } from "effect";
import { Update } from "foldkit";
import type { Message } from "./message";
import type { Model } from "./model";

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> => {
  if (Predicate.isTagged(model, "InvalidInput")) return ({ model: model, commands: [] });

  return M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      OpenedMobileNavigation: () => ({ model: 
        {
          ...model,
          isMobileNavigationOpen: true,
        }, commands: [] }),
      ClosedMobileNavigation: () => ({ model: 
        {
          ...model,
          isMobileNavigationOpen: false,
          isProfileMenuOpen: false,
        }, commands: [] }),
      ToggledAdmissionMenu: ({ isOpen }) => ({ model: 
        {
          ...model,
          isAdmissionMenuOpen: isOpen,
        }, commands: [] }),
      ToggledProfileMenu: ({ isOpen }) => ({ model: 
        {
          ...model,
          isProfileMenuOpen: isOpen,
        }, commands: [] }),
      ActivatedNavigation: ({ path }) => ({ model: 
        {
          ...model,
          activePath: path,
          isMobileNavigationOpen: false,
          isProfileMenuOpen: false,
        }, commands: [] }),
      DismissedNavigation: () => ({ model: 
        {
          ...model,
          isMobileNavigationOpen: false,
          isAdmissionMenuOpen: false,
          isProfileMenuOpen: false,
        }, commands: [] }),
    }),
  );
};
