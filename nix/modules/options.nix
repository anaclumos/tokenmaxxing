{ lib, ... }:
{
  options.programs.tokenmaxxing = {
    enable = lib.mkEnableOption "tokenmaxxing (pooled Claude Code / Codex account switching)";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression "pkgs.tokenmaxxing  # via this flake's overlay, or set explicitly";
      description = ''
        tokenmaxxing package to install. Leave null to use `pkgs.tokenmaxxing`
        (requires this flake's overlay). Or set explicitly:

            programs.tokenmaxxing.package = inputs.tokenmaxxing.packages.''${pkgs.system}.default;
      '';
    };

    checkTimer = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Declaratively install the periodic `tokenmaxxing check` timer
          (launchd on nix-darwin / Home Manager on macOS, systemd user timer
          under Home Manager / NixOS on Linux). Defaults to false so
          `tokenmaxxing init`'s own timer remains the single owner; enable this
          only when you want Nix to manage the timer instead (then skip relying
          on init's copy, or re-run init after disabling this so the two do not
          double-fire).
        '';
      };

      intervalSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 180;
        description = "How often to run `tokenmaxxing check`.";
      };
    };
  };
}
