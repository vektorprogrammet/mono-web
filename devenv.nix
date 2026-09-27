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

  # Linked worktrees share one hooks directory, but each worktree has its own hook configuration,
  # which `devenv shell` generates from these files. Tool versions follow the shell, not this list.
  hookSources = [
    ./devenv.nix
    ./devenv.yaml
    ./devenv.lock
  ];
  hookConfigPath = config.git-hooks.configPath;
  prek = lib.getExe config.git-hooks.package;

  # The first hook of every stage: it fails when the configuration was generated from other
  # versions of the hook sources. It compares with the worktree, which prek has reduced to the
  # staged content during pre-commit. With `HEAD` it compares with HEAD instead: during
  # pre-merge-commit the worktree holds the merged files, but the configuration of HEAD gates the
  # merge, and Git writes MERGE_HEAD only after the hook.
  hookConfigCurrent = pkgs.writeShellScript "hook-config-current" ''
    set -uo pipefail
    if [ "''${1:-}" = HEAD ]; then
      source=HEAD
      contents() { ${lib.getExe pkgs.git} show "HEAD:$1"; }
    else
      source="this worktree"
      contents() { ${pkgs.coreutils}/bin/cat -- "$1"; }
    fi
    stale=()
    ${lib.concatMapStrings (
      path:
      let
        file = baseNameOf (toString path);
      in
      ''
        [ "$(contents ${file} | ${pkgs.coreutils}/bin/sha256sum)" = "${builtins.hashFile "sha256" path}  -" ] || stale+=(${file})
      ''
    ) hookSources}
    if [ "''${#stale[@]}" -gt 0 ]; then
      echo "The Git hook configuration of $PWD was generated from another ''${stale[*]} than $source has." >&2
      echo "Run \`devenv shell\` in $PWD to regenerate it (non-interactively: \`devenv shell -- true\`), then retry." >&2
      exit 1
    fi
  '';

  # The shim that `devenv:git-hooks:install` writes into the shared hooks directory. Git runs it
  # from the top level of the worktree that commits, merges, or pushes. Prek's own shim exits 0
  # when the configuration is missing (with `--allow-missing-config`) or advertises a bypass
  # (without it), so a new worktree committed without any check until someone ran `devenv shell`.
  hookShim =
    stage:
    pkgs.writeScript "git-hook-${stage}" ''
      #!/bin/sh
      # Generated by devenv.nix (devenv:git-hooks:install); `devenv shell` rewrites it.
      if [ ! -e ${hookConfigPath} ] || [ ! -x ${prek} ]; then
        echo "error: $PWD has no generated Git hook configuration (${hookConfigPath}), so no check can run." >&2
        echo "Run \`devenv shell\` in $PWD once to generate it (non-interactively: \`devenv shell -- true\`), then retry." >&2
        exit 1
      fi
      exec ${prek} hook-impl --hook-type=${stage} --config=${hookConfigPath} -- "$@"
    '';
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

  # Every hook runs a `just` recipe; the justfile is the one command surface. The exceptions are the
  # configuration check, which must not depend on the configuration's tools, and the stock
  # conflict-marker check: an unresolved merge or rebase once committed its markers (2026-09-26).
  git-hooks.hooks = {
    hook-config-current = hook {
      entry = "${hookConfigCurrent}";
      stages = [
        "pre-commit"
        "pre-push"
      ];
      priority = 0;
      fail_fast = true;
    };
    hook-config-current-merge = hook {
      entry = "${hookConfigCurrent} HEAD";
      stages = [ "pre-merge-commit" ];
      priority = 0;
      fail_fast = true;
    };
    check-merge-conflicts = {
      enable = true;
      # The stock check only looks while Git records a merge; rebases and cherry-picks do not.
      args = [ "--assume-in-merge" ];
      stages = [
        "pre-commit"
        "pre-merge-commit"
      ];
      priority = 1;
      fail_fast = true;
    };
    # One formatter process for the staged paths. Prek must not launch a pool per file batch.
    format = {
      enable = true;
      entry = "${hookEnv} just format --check --no-error-on-unmatched-pattern";
      require_serial = true;
      stages = [ "pre-commit" ];
      priority = 1;
      fail_fast = true;
    };
    # Type-aware lint still takes a hook slot, but it targets only staged JS/TS paths.
    # Full route type generation and whole-tree lint run at merge/push.
    lint = {
      enable = true;
      entry = "${hookEnv} just hook-slot --class hook-pre-commit-lint -- just lint-files --no-error-on-unmatched-pattern";
      files = "\\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$";
      require_serial = true;
      stages = [ "pre-commit" ];
      priority = 1;
      fail_fast = true;
    };
    # Only changed index blobs are read on commit. The full index runs in just check.
    source-safety = hook {
      entry = "${hookEnv} just source-safety --changed";
      stages = [ "pre-commit" ];
      priority = 1;
      fail_fast = true;
    };
    # Whole-tree checks, types, and every package test run against the merged result.
    # just land always creates a merge commit, including when the branch can fast-forward.
    merge-full = hook {
      entry = "${hookEnv} just measure --class hook-pre-merge-full -- bash -c 'just check --concurrency=1 && just test --concurrency=1'";
      stages = [ "pre-merge-commit" ];
      priority = 2;
      fail_fast = true;
    };
    push-check = hook {
      # `just check` passes its arguments to `turbo check-types`.
      entry = "${hookEnv} just hook-slot --class hook-pre-push-check -- just check --concurrency=1";
      stages = [ "pre-push" ];
      priority = 1;
      fail_fast = true;
    };
    push-test = hook {
      entry = "${hookEnv} just hook-slot --class hook-pre-push-test -- just test --affected --concurrency=1";
      stages = [ "pre-push" ];
      priority = 2;
    };
  };

  tasks = {
    # The shims read the configuration of the worktree that runs them and refuse to run without
    # one (`hookShim`). They replace prek's shims and the former Lefthook shims. CI never installs hooks.
    "devenv:git-hooks:install" = {
      exec = lib.mkForce ''
        set -eu
        hooks_dir=$(${lib.getExe pkgs.git} rev-parse --path-format=absolute --git-path hooks)
        mkdir -p "$hooks_dir"
        ${lib.concatMapStrings (stage: ''
          install -m 0755 ${hookShim stage} "$hooks_dir/.${stage}.new"
          mv -f "$hooks_dir/.${stage}.new" "$hooks_dir/${stage}"
        '') config.git-hooks.installStages}
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
