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

    home.sessionVariables = lib.mkMerge [
      (lib.mkIf cfg.checkTimer.enable {
        TOKENMAXXING_SKIP_TIMER = "1";
      })
      (lib.mkIf cfg.hub.enable {
        TOKENMAXXING_SKIP_HUB = "1";
      })
    ];

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
        OnBootSec = toString cfg.checkTimer.intervalSeconds;
        OnUnitActiveSec = toString cfg.checkTimer.intervalSeconds;
        AccuracySec = toString (lib.max 1 (cfg.checkTimer.intervalSeconds / 12));
        Persistent = "true";
        Unit = "tokenmaxxing-check.service";
      };
      Install.WantedBy = [ "timers.target" ];
    };

    launchd.agents.tokenmaxxing-hub = lib.mkIf (cfg.hub.enable && hostPlatform.isDarwin && package != null) {
      enable = true;
      config = {
        ProgramArguments = [
          (lib.getExe package)
          "serve"
        ];
        KeepAlive = true;
        RunAtLoad = true;
        StandardOutPath = "/dev/null";
        StandardErrorPath = "${config.home.homeDirectory}/.config/tokenmaxxing/hub.stderr.log";
      };
    };

    systemd.user.services.tokenmaxxing-hub =
      lib.mkIf (cfg.hub.enable && hostPlatform.isLinux && package != null)
        {
          Unit.Description = "tokenmaxxing usage hub";
          Service = {
            ExecStart = "${lib.getExe package} serve";
            Restart = "on-failure";
            RestartSec = "5";
          };
          Install.WantedBy = [ "default.target" ];
        };
  };
}
