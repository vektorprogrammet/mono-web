# The development environment. `devenv shell` is the entry point, locally and in CI.
# README.md#toolchain lists what it owns and which commands need the `legacy` profile.
{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
let
  manifest = lib.importJSON ./package.json;

  # The manifest declares each version once: packageManager "bun@<version>",
  # engines.node ">=<major>" (the lowest supported major) and engines.postgresql
  # "<major> || <major>" (the supported PostgreSQL majors).
  bunVersion = lib.removePrefix "bun@" manifest.packageManager;
  nodeMajor = lib.head (builtins.match ">=([0-9]+)" manifest.engines.node);

  # The highest supported PostgreSQL major is the default. VEKTOR_POSTGRES_MAJOR
  # selects another one; devenv re-evaluates when the variable changes.
  # tools/postgres/index.ts decodes and selects the same way.
  postgresMajors =
    let
      declared = manifest.engines.postgresql;
      majors = map lib.toInt (lib.splitString " || " declared);
    in
    if
      builtins.match "[1-9][0-9]*( \\|\\| [1-9][0-9]*)*" declared == null
      || lib.length (lib.unique majors) != lib.length majors
    then
      throw ''package.json engines.postgresql must be distinct PostgreSQL majors joined by " || ", not "${declared}".''
    else
      lib.sort lib.lessThan majors;
  postgresMajor =
    let
      requested = builtins.getEnv "VEKTOR_POSTGRES_MAJOR";
      supported = map toString postgresMajors;
    in
    if requested == "" then
      lib.last supported
    else if lib.elem requested supported then
      requested
    else
      throw "VEKTOR_POSTGRES_MAJOR=${requested} is not a supported PostgreSQL major. package.json engines.postgresql supports ${lib.concatStringsSep " || " supported}.";

  # Playwright runs only the browser build of its own version, so the browsers
  # follow the @playwright/test version that bun.lock resolves.
  playwrightVersion =
    let
      prefix = "    \"@playwright/test\": [\"@playwright/test@";
      entry = lib.findFirst (lib.hasPrefix prefix) (throw "bun.lock resolves no @playwright/test") (
        lib.splitString "\n" (builtins.readFile ./bun.lock)
      );
    in
    lib.head (lib.splitString ''"'' (lib.removePrefix prefix entry));

  # The rolling nixpkgs ships newer Bun and Playwright versions. Multiverse picks
  # the fewest historical nixpkgs revisions that shipped exactly these ones.
  pinned =
    (inputs.nixpkgs-multiverse.lib.mkMultiverse { inherit (pkgs.stdenv.hostPlatform) system; }).solvePins
      {
        bun = bunVersion;
        playwright-driver = playwrightVersion;
      };

  browsers = pinned.playwright-driver.browsers.override {
    withFirefox = false;
    withWebkit = false;
  };

  # Playwright's per-architecture directory of the Chrome for Testing build.
  chromeDirectory =
    {
      x86_64-linux = "chrome-linux64";
      aarch64-linux = "chrome-linux";
    }
    .${pkgs.stdenv.hostPlatform.system} or null;

  # Git runs hooks with the caller's PATH, also for commits outside `devenv shell`.
  hookEnv = pkgs.writeShellScript "hook-env" ''
    PATH=${config.devenv.profile}/bin:$PATH exec "$@"
  '';

  hook = attrs: {
    enable = true;
    pass_filenames = false;
    always_run = true;
  } // attrs;
in
{
  languages.javascript = {
    enable = true;
    package = pkgs."nodejs_${nodeMajor}";
    bun = {
      enable = true;
      package = pinned.bun;
    };
    lsp.enable = false;
  };

  packages = [
    pkgs.git
    pkgs.openssl
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
    # tools/postgres reads the major that PATH provides from here.
    VEKTOR_POSTGRES_MAJOR = postgresMajor;
  }
  // lib.optionalAttrs (chromeDirectory != null) {
    # Launchers that pass `executablePath` read this variable.
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pinned.playwright-driver.passthru.components.chromium}/${chromeDirectory}/chrome";
  };

  # The local database for `devenv up`. Tests start their own disposable clusters.
  # devenv.yaml sets strict_ports, so `devenv up` fails instead of moving to another
  # port, and PGHOST and PGPORT in every shell name this server.
  services.postgres = {
    enable = true;
    package = pkgs."postgresql_${postgresMajor}";
    listen_addresses = "127.0.0.1";
    port = 5480;
    # The owner role creates the schema; btree_gist is a trusted extension.
    initialDatabases = [
      {
        name = "vektorprogrammet";
        user = "vektorprogrammet";
      }
    ];
  };

  # `devenv up` starts PostgreSQL, then `bun dev` against it.
  processes.app = lib.mkIf (!config.devenv.isTesting) {
    exec = "bun run dev";
    env.BACKEND_PG_URL = "postgresql://vektorprogrammet@127.0.0.1:${toString config.env.PGPORT}/vektorprogrammet";
    after = [ "devenv:processes:postgres" ];
  };

  git-hooks.hooks = {
    # Staged files only. .oxfmtrc.json owns the formatter scope, also for explicit paths.
    format = {
      enable = true;
      entry = "${hookEnv} bun x oxfmt --check --no-error-on-unmatched-pattern";
      stages = [ "pre-commit" ];
      priority = 0;
      fail_fast = true;
    };
    lint = {
      enable = true;
      entry = "${hookEnv} bun x oxlint --no-error-on-unmatched-pattern";
      files = "\\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$";
      stages = [ "pre-commit" ];
      priority = 0;
      fail_fast = true;
    };
    # The whole staged tree, whatever the task cache holds: no credential, personal data, or
    # literal SQL data enters the public repository.
    source-safety = hook {
      entry = "${hookEnv} bun --no-env-file tools/source-safety/src/check.ts";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # Type checks and tests of the packages that the staged tree changes.
    changed-packages = hook {
      entry = "${hookEnv} bun --no-env-file scripts/check-staged.ts --class hook-pre-commit";
      stages = [ "pre-commit" ];
      priority = 1;
    };
    # A merge without conflicts skips pre-commit. Its staged tree is the merge result.
    merged-packages = hook {
      entry = "${hookEnv} bun --no-env-file scripts/check-staged.ts --class hook-pre-merge-commit --dependents";
      stages = [ "pre-merge-commit" ];
    };
    push-check = hook {
      # `bun run` appends the flag to the last command of `check`, `turbo check-types`.
      entry = "${hookEnv} bun --no-env-file scripts/hook-slot.ts --class hook-pre-push-check -- bun run check --concurrency=1";
      stages = [ "pre-push" ];
      priority = 0;
      fail_fast = true;
    };
    push-test = hook {
      entry = "${hookEnv} bun --no-env-file scripts/hook-slot.ts --class hook-pre-push-test -- bun x turbo run test --affected --concurrency=1";
      stages = [ "pre-push" ];
      priority = 1;
    };
  };

  tasks = {
    # Linked worktrees share one hooks directory, so the hooks read the configuration
    # of the worktree that runs them. `--force` replaces the former Lefthook shims.
    # CI never installs hooks.
    "devenv:git-hooks:install" = {
      exec = lib.mkForce ''
        ${lib.getExe config.git-hooks.package} install --force --allow-missing-config --config ${config.git-hooks.configPath} ${
          lib.concatMapStringsSep " " (stage: "--hook-type ${stage}") config.git-hooks.installStages
        }
      '';
      status = ''test -n "''${CI:-}"'';
    };
    # devenv 2.3.1 runs enterTest dependencies on shell entry; hooks run on commit and push.
    "devenv:git-hooks:run".before = lib.mkForce [ ];
  };

  # `devenv test`: the services and tools that tests and journeys start work together.
  enterTest = ''
    wait_for_processes 120
    psql --dbname=vektorprogrammet --set=ON_ERROR_STOP=1 --quiet \
      --command='CREATE EXTENSION btree_gist' --command='DROP EXTENSION btree_gist'
    openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /dev/null
    "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" --headless --no-sandbox --dump-dom 'data:text/html,<p>devenv</p>' \
      | grep --fixed-strings --quiet '<p>devenv</p>'
  '';

  profiles.legacy.module = {
    # The retained Symfony application and the legacy rehearsals.
    languages.php = {
      enable = true;
      version = lib.head (
        builtins.match ">=([0-9]+\\.[0-9]+)" (lib.importJSON ./apps/server/composer.json).require.php
      );
      lsp.enable = false;
    };
    packages = [ pkgs.mariadb ];
    env.VEKTOR_LEGACY_TOOLCHAIN = "1";
  };
}
