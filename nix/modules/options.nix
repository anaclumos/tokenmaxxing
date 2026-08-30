{ lib, ... }:
{
  options.programs.tokenmaxxing = {
    enable = lib.mkEnableOption "tokenmaxxing (pooled Claude Code / Codex account switching)";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression "null  # falls back to pkgs.tokenmaxxing when this flake's overlay is applied";
      description = ''
        tokenmaxxing package to install. Leave null to use `pkgs.tokenmaxxing`
        (requires this flake's overlay / `*.withOverlay`). Or set explicitly:

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
          `tokenmaxxing init`'s own timer remains the single owner.

          When enabled, the module also exports `TOKENMAXXING_SKIP_TIMER=1` so
          a subsequent `tokenmaxxing init` does not write a second imperative
          timer. If you already ran init before enabling this, remove the
          imperative timer once (`launchctl bootout gui/$(id -u)/com.tokenmaxxing.check`
          on macOS, or `systemctl --user disable --now tokenmaxxing-check.timer`
          on Linux) so only the Nix-managed unit fires.
        '';
      };

      intervalSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 60;
        description = "The floor tick for `tokenmaxxing check`; the check itself sleeps longer while the live account has headroom.";
      };
    };
  };
}
