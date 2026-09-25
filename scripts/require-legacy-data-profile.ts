// Legacy data rehearsals start MariaDB or the PHP CLI, which only the devenv `legacy-data`
// profile provides; it sets VEKTOR_LEGACY_DATA. The default shell has neither.
if (process.env.VEKTOR_LEGACY_DATA !== "1") {
  process.stderr.write(
    "This command needs the legacy data tools (MariaDB, PHP CLI). " +
      "Run it inside `devenv --profile legacy-data shell`.\n",
  );
  process.exit(1);
}
