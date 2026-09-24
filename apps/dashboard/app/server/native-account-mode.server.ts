/** Native sign-in and recovery cannot be composed with the retained Symfony reset source. */
export const nativeDashboardRecoveryMode = (
  env: Readonly<Record<string, string | undefined>>,
): "native" | "disabled" => {
  const value = env.PASSWORD_RECOVERY_ENGINE;

  if (value === undefined) return "disabled";

  if (value === "native") return "native";
  throw new Error(
    "This native dashboard supports only native password recovery or disabled recovery",
  );
};
