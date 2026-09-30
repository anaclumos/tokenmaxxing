{
  config,
  lib,
  ...
}:
let
  cfg = config.programs.tokenmaxxing;
in
{
  imports = [ ./options.nix ];

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    environment.variables = lib.mkMerge [
      (lib.mkIf cfg.checkTimer.enable {
        TOKENMAXXING_SKIP_TIMER = "1";
      })
      (lib.mkIf cfg.hub.enable {
        TOKENMAXXING_SKIP_HUB = "1";
      })
    ];

    systemd.user.services.tokenmaxxing-check = lib.mkIf cfg.checkTimer.enable {
      description = "tokenmaxxing account-switch check";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe cfg.package} check";
      };
    };

    systemd.user.timers.tokenmaxxing-check = lib.mkIf cfg.checkTimer.enable {
      description = "tokenmaxxing periodic account-switch check";
      timerConfig = {
        OnBootSec = toString cfg.checkTimer.intervalSeconds;
        OnUnitActiveSec = toString cfg.checkTimer.intervalSeconds;
        AccuracySec = toString (lib.max 1 (cfg.checkTimer.intervalSeconds / 12));
        Unit = "tokenmaxxing-check.service";
      };
      wantedBy = [ "timers.target" ];
    };

    systemd.user.services.tokenmaxxing-hub = lib.mkIf cfg.hub.enable {
      description = "tokenmaxxing usage hub";
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} serve";
        Restart = "on-failure";
        RestartSec = "5";
      };
      wantedBy = [ "default.target" ];
    };
  };
}
