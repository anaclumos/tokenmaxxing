# NixOS module. Import via this flake's `nixosModules.default`.
# Same surface as the darwin module: package on PATH, optional systemd user timer.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.tokenmaxxing;
  package = if cfg.package != null then cfg.package else pkgs.tokenmaxxing or null;
in
{
  imports = [ ./options.nix ];

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = package != null;
        message = "programs.tokenmaxxing.package must be set (import this flake's overlay / nixosModules.withOverlay, or set package = inputs.tokenmaxxing.packages.\${pkgs.system}.default).";
      }
    ];

    environment.systemPackages = lib.mkIf (package != null) [ package ];

    # Keep init from writing a second imperative timer when Nix owns it.
    environment.variables = lib.mkIf cfg.checkTimer.enable {
      TOKENMAXXING_SKIP_TIMER = "1";
    };

    systemd.user.services.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && package != null) {
      description = "tokenmaxxing account-switch check";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe package} check";
      };
    };

    # User timer (same model as `tokenmaxxing init`): runs while the user
    # session is active. Headless boxes need lingering
    # (`loginctl enable-linger <user>`) for the timer to fire without a login.
    systemd.user.timers.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && package != null) {
      description = "tokenmaxxing periodic account-switch check";
      timerConfig = {
        OnBootSec = "60";
        OnUnitActiveSec = toString cfg.checkTimer.intervalSeconds;
        AccuracySec = "30";
        Persistent = true;
        Unit = "tokenmaxxing-check.service";
      };
      wantedBy = [ "timers.target" ];
    };
  };
}
