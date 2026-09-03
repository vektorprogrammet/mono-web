import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const installer = join(repositoryRoot, "infra", "host", "preview-services.sh");

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await writeFile(path, content);
  await chmod(path, 0o755);
};

it("installs the exact native dev-main identity policy without replacing the secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-services-"));
  try {
    const home = join(root, "home");
    const stateDirectory = join(root, "state");
    const configDirectory = join(root, "config");
    const unitDirectory = join(root, "units");
    const stubDirectory = join(root, "bin");
    const callLog = join(root, "calls.log");
    const profileBin = join(home, ".nix-profile", "bin");
    await Promise.all([
      mkdir(configDirectory, { recursive: true }),
      mkdir(unitDirectory, { recursive: true }),
      mkdir(stubDirectory, { recursive: true }),
      mkdir(profileBin, { recursive: true }),
    ]);

    await Promise.all([
      writeExecutable(join(profileBin, "bun"), "#!/bin/sh\nexit 0\n"),
      writeExecutable(join(stubDirectory, "cloudflared"), "#!/bin/sh\nexit 0\n"),
      writeExecutable(join(stubDirectory, "nix-store"), "#!/bin/sh\nexit 0\n"),
      writeExecutable(
        join(stubDirectory, "systemctl"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PREVIEW_SERVICES_CALL_LOG"\n',
      ),
      writeExecutable(
        join(stubDirectory, "loginctl"),
        '#!/bin/sh\nif [ "$1" = "show-user" ]; then printf "yes\\n"; fi\n',
      ),
    ]);

    const environmentFile = join(configDirectory, "backend.env");
    const backendUnit = join(unitDirectory, "vektor-preview-backend.service");
    const originalEnvironment = "BETTER_AUTH_SECRET=existing-test-secret\n";
    await writeFile(environmentFile, originalEnvironment, { mode: 0o644 });
    await writeFile(backendUnit, "stale unit content\n");

    const result = spawnSync("bash", [installer, "install"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USER: "preview-test",
        PATH: `${stubDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        PREVIEW_SERVICES_CALL_LOG: callLog,
        VEKTOR_PREVIEW_STATE_DIR: stateDirectory,
        VEKTOR_PREVIEW_CONFIG_DIR: configDirectory,
        VEKTOR_PREVIEW_UNIT_DIR: unitDirectory,
        VEKTOR_PREVIEW_PG_PORT: "5544",
      },
      encoding: "utf8",
    });
    expect(result.stderr).toContain("install complete");
    expect(result.status).toBe(0);

    const renderedUnit = await readFile(backendUnit, "utf8");
    const identityNames = [
      "NATIVE_IDENTITY_DEPLOYMENT",
      "NATIVE_IDENTITY_TRUSTED_ORIGINS",
      "OAUTH_CANONICAL_ORIGIN",
      "OAUTH_DASHBOARD_ORIGIN",
      "OAUTH_NATIVE_API_RESOURCE",
    ];
    expect(
      renderedUnit
        .split("\n")
        .filter((line) => identityNames.some((name) => line.includes(`${name}=`))),
    ).toEqual([
      "Environment=NATIVE_IDENTITY_DEPLOYMENT=preview",
      "Environment='NATIVE_IDENTITY_TRUSTED_ORIGINS=[\"https://vektor.phibkro.org\"]'",
      "Environment=OAUTH_CANONICAL_ORIGIN=https://vektor.phibkro.org",
      "Environment=OAUTH_DASHBOARD_ORIGIN=https://vektor.phibkro.org",
      "Environment=OAUTH_NATIVE_API_RESOURCE=urn:vektorprogrammet:native-api",
    ]);
    expect(renderedUnit).not.toContain("BETTER_AUTH_URL");
    expect(renderedUnit).not.toContain("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(renderedUnit).not.toContain("stale unit content");

    expect(await readFile(environmentFile, "utf8")).toBe(originalEnvironment);
    expect((await stat(environmentFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(callLog, "utf8")).toContain("--user daemon-reload");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
