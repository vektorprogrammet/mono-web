// Commands that start PHP or MariaDB run only in the devenv `legacy` profile,
// which sets VEKTOR_LEGACY_TOOLCHAIN. The default shell has no legacy tools.
if (process.env.VEKTOR_LEGACY_TOOLCHAIN !== "1") {
  process.stderr.write(
    "This command needs the legacy toolchain (PHP, Composer, MariaDB). " +
      "Run it inside `devenv --profile legacy shell`.\n",
  );
  process.exit(1);
}
