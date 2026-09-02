{
  description = "tokenmaxxing: pool Claude Code / Codex subscription logins and hot-swap near quota";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix.url = "github:nix-community/bun2nix?ref=2.1.2";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
  };

  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    inputs:
    let
      inherit (inputs.nixpkgs) lib;
      eachSystem = lib.genAttrs (import inputs.systems);

      pkgsFor = eachSystem (
        system:
        import inputs.nixpkgs {
          inherit system;
          overlays = [
            inputs.bun2nix.overlays.default
            inputs.self.overlays.default
          ];
        }
      );
    in
    {
      overlays.default = lib.composeExtensions inputs.bun2nix.overlays.default (
        final: _prev: {
          tokenmaxxing = final.callPackage ./nix/package.nix { };
        }
      );

      packages = eachSystem (system: {
        default = pkgsFor.${system}.tokenmaxxing;
        tokenmaxxing = pkgsFor.${system}.tokenmaxxing;
      });

      apps = eachSystem (system: {
        default = {
          type = "app";
          program = lib.getExe inputs.self.packages.${system}.default;
        };
      });

      darwinModules.default = import ./nix/modules/darwin.nix;
      homeManagerModules.default = import ./nix/modules/home-manager.nix;
      nixosModules.default = import ./nix/modules/nixos.nix;

      darwinModules.withOverlay =
        { ... }:
        {
          nixpkgs.overlays = [ inputs.self.overlays.default ];
          imports = [ inputs.self.darwinModules.default ];
        };
      homeManagerModules.withOverlay =
        { ... }:
        {
          nixpkgs.overlays = [ inputs.self.overlays.default ];
          imports = [ inputs.self.homeManagerModules.default ];
        };
      nixosModules.withOverlay =
        { ... }:
        {
          nixpkgs.overlays = [ inputs.self.overlays.default ];
          imports = [ inputs.self.nixosModules.default ];
        };

      checks = eachSystem (system: {
        package = inputs.self.packages.${system}.default;
      });

      formatter = eachSystem (system: pkgsFor.${system}.nixfmt);

      devShells = eachSystem (system: {
        default = pkgsFor.${system}.mkShell {
          packages = with pkgsFor.${system}; [
            bun
            bun2nix
            nixfmt
          ];
          shellHook = ''
            bun install --frozen-lockfile
          '';
        };
      });
    };
}
