# The development environment. `devenv shell` is the entry point, locally and in CI.
# README.md#toolchain lists what it owns and which commands need the `legacy-data` profile.
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

  # secretspec.toml's Bitwarden Secrets Manager provider calls the official bws CLI.
  # nixpkgs builds bws from source because it is unfree, so no binary cache holds it and
  # every CI run would compile it. This is Bitwarden's static release binary, pinned to the
  # sha256 in the release's bws-sha256-checksums file.
  bws =
    let
      version = "2.1.0";
      release =
        {
          x86_64-linux = {
            triple = "x86_64-unknown-linux-musl";
            sha256 = "f59ee150e42b82128d437087e9bac920053c6bfddcb960d20ce9386e5ac9bba6";
          };
          aarch64-linux = {
            triple = "aarch64-unknown-linux-musl";
            sha256 = "eb0f1ae61d1c3b74244d2841233276e05c77e8be4da197ed90fc6248387005e1";
          };
        }
        .${pkgs.stdenv.hostPlatform.system}
          or (throw "No bws ${version} release binary is pinned for ${pkgs.stdenv.hostPlatform.system}.");
    in
    pkgs.stdenvNoCC.mkDerivation {
      pname = "bws";
      inherit version;
      src = pkgs.fetchurl {
        url = "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${version}/bws-${release.triple}-${version}.zip";
        inherit (release) sha256;
      };
      nativeBuildInputs = [ pkgs.unzip ];
      sourceRoot = ".";
      installPhase = "install -Dm755 bws $out/bin/bws";
      meta.license = lib.licenses.unfree;
    };

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
    bws
    pkgs.git
    pkgs.just
    pkgs.openssl
    # tools/postgres starts a disposable PgBouncer in front of a disposable cluster.
    pkgs.pgbouncer
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

  # `devenv up` starts PostgreSQL, then `just dev` against it.
  processes.app = lib.mkIf (!config.devenv.isTesting) {
    exec = "just dev";
    env.BACKEND_PG_URL = "postgresql://vektorprogrammet@127.0.0.1:${toString config.env.PGPORT}/vektorprogrammet";
    after = [ "devenv:processes:postgres" ];
  };

  # Every hook runs a `just` recipe; the justfile is the one command surface. The one exception is the
  # stock conflict-marker check: an unresolved merge or rebase once committed its markers (2026-09-26).
  git-hooks.hooks = {
    check-merge-conflicts = {
      enable = true;
      # The stock check only looks while Git records a merge; rebases and cherry-picks do not.
      args = [ "--assume-in-merge" ];
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # Staged files only. .oxfmtrc.json owns the formatter scope, also for explicit paths.
    format = {
      enable = true;
      entry = "${hookEnv} just format --check --no-error-on-unmatched-pattern";
      stages = [ "pre-commit" ];
      priority = 0;
      fail_fast = true;
    };
    # Type-aware lint builds TypeScript programs, so it runs in a hook slot like the type checks.
    # One process lints every staged file: parallel batches would each regenerate the same
    # React Router route types at once, and one batch then reads another's half-written files.
    lint = {
      enable = true;
      entry = "${hookEnv} just hook-slot --class hook-pre-commit-lint -- just lint --no-error-on-unmatched-pattern";
      files = "\\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$";
      require_serial = true;
      stages = [ "pre-commit" ];
      priority = 0;
      fail_fast = true;
    };
    # The whole staged tree, whatever the task cache holds: no credential, personal data, or
    # literal SQL data enters the public repository.
    source-safety = hook {
      entry = "${hookEnv} just source-safety";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # The whole staged tree against the layout declaration, the context map, and the generated
    # README and AGENTS.md sections and hosted journey legs.
    layout = hook {
      entry = "${hookEnv} just layout --staged";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # The whole staged tree's construct tags and imports against docs/constructs.md.
    constructs = hook {
      entry = "${hookEnv} just constructs --staged";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # The module guides and their CLAUDE.md links against the context map, the construct tags,
    # and the package exports of the staged tree.
    guides = hook {
      entry = "${hookEnv} just guides --staged";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # Every suppression of an Effect rule in the staged tree names its entry in
    # docs/effect-exceptions.json, and every entry names current sites and package versions.
    exceptions = hook {
      entry = "${hookEnv} just exceptions --staged";
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 0;
      fail_fast = true;
    };
    # Type checks and tests of the packages that the staged tree changes.
    changed-packages = hook {
      entry = "${hookEnv} just check-staged --class hook-pre-commit";
      stages = [ "pre-commit" ];
      priority = 1;
    };
    # A merge without conflicts skips pre-commit. Its staged tree is the merge result.
    merged-packages = hook {
      entry = "${hookEnv} just check-staged --class hook-pre-merge-commit --dependents";
      stages = [ "pre-merge-commit" ];
    };
    push-check = hook {
      # `just check` passes its arguments to `turbo check-types`.
      entry = "${hookEnv} just hook-slot --class hook-pre-push-check -- just check --concurrency=1";
      stages = [ "pre-push" ];
      priority = 0;
      fail_fast = true;
    };
    push-test = hook {
      entry = "${hookEnv} just hook-slot --class hook-pre-push-test -- just test --affected --concurrency=1";
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

  profiles.legacy-data.module = {
    # Legacy data rehearsals: MariaDB restores and reads legacy-shaped databases, and the
    # PHP CLI (the legacy 8.4 line, without Composer) makes legacy-format bcrypt hashes.
    packages = [
      pkgs.mariadb
      pkgs.php84
    ];
    env.VEKTOR_LEGACY_DATA = "1";
  };
}
