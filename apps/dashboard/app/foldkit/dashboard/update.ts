import { Match as M } from "effect";
import type { Command } from "foldkit";
import type { Message } from "./message";
import type { Model } from "./model";

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] => {
  if (model._tag === "InvalidInput") return [model, []];

  return M.value(message).pipe(
    M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    M.tagsExhaustive({
      OpenedMobileNavigation: () => [
        {
          ...model,
          isMobileNavigationOpen: true,
        },
        [],
      ],
      ClosedMobileNavigation: () => [
        {
          ...model,
          isMobileNavigationOpen: false,
          isProfileMenuOpen: false,
        },
        [],
      ],
      ToggledAdmissionMenu: ({ isOpen }) => [
        {
          ...model,
          isAdmissionMenuOpen: isOpen,
        },
        [],
      ],
      ToggledProfileMenu: ({ isOpen }) => [
        {
          ...model,
          isProfileMenuOpen: isOpen,
        },
        [],
      ],
      ActivatedNavigation: ({ path }) => [
        {
          ...model,
          activePath: path,
          isMobileNavigationOpen: false,
          isProfileMenuOpen: false,
        },
        [],
      ],
      DismissedNavigation: () => [
        {
          ...model,
          isMobileNavigationOpen: false,
          isAdmissionMenuOpen: false,
          isProfileMenuOpen: false,
        },
        [],
      ],
    }),
  );
};
