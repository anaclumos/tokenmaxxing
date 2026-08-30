{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.tokenmaxxing;
  package = if cfg.package != null then cfg.package else pkgs.tokenmaxxing or null;
  inherit (pkgs.stdenv) hostPlatform;
in
{
  imports = [ ./options.nix ];

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = package != null;
        message = "programs.tokenmaxxing.package must be set (apply this flake's overlay to the pkgs used by Home Manager, or set package = inputs.tokenmaxxing.packages.\${pkgs.system}.default).";
      }
    ];

    home.packages = lib.mkIf (package != null) [ package ];

    home.sessionPath = [ "${config.xdg.configHome}/tokenmaxxing/bin" ];

    home.sessionVariables = lib.mkIf cfg.checkTimer.enable {
      TOKENMAXXING_SKIP_TIMER = "1";
    };

    launchd.agents.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && hostPlatform.isDarwin && package != null) {
      enable = true;
      config = {
        ProgramArguments = [
          (lib.getExe package)
          "check"
        ];
        StartInterval = cfg.checkTimer.intervalSeconds;
        StandardOutPath = "/dev/null";
        StandardErrorPath = "${config.home.homeDirectory}/.config/tokenmaxxing/check.stderr.log";
      };
    };

    systemd.user.services.tokenmaxxing-check =
      lib.mkIf (cfg.checkTimer.enable && hostPlatform.isLinux && package != null)
        {
          Unit.Description = "tokenmaxxing account-switch check";
          Service = {
            Type = "oneshot";
            ExecStart = "${lib.getExe package} check";
          };
        };

    systemd.user.timers.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && hostPlatform.isLinux && package != null) {
      Unit.Description = "tokenmaxxing periodic account-switch check";
      Timer = {
        OnBootSec = "60";
        OnUnitActiveSec = toString cfg.checkTimer.intervalSeconds;
        AccuracySec = "30";
        Persistent = "true";
        Unit = "tokenmaxxing-check.service";
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };
}
