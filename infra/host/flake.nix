{
  description = "Host-side toolchain for the vektor.phibkro.org apex preview (PostgreSQL 17, Bun, Node).";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          postgresql_17
          bun
          nodejs_24
          openssl
          cloudflared
        ];

        # The apex preview cluster binds this loopback-only port. 5432 is the
        # host's default cluster and 5433 belongs to an unrelated local agent.
        VEKTOR_PREVIEW_PG_PORT = "5434";
      };
    };
}
