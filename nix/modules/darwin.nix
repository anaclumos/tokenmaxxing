{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.tokenmaxxing;
  package = if cfg.package != null then cfg.package else pkgs.tokenmaxxing or null;
  primaryUser = config.system.primaryUser or null;
  home =
    if primaryUser != null && config.users.users ? ${primaryUser} then
      config.users.users.${primaryUser}.home
    else
      null;
in
{
  imports = [ ./options.nix ];

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = package != null;
        message = "programs.tokenmaxxing.package must be set (import this flake's overlay / darwinModules.withOverlay, or set package = inputs.tokenmaxxing.packages.\${pkgs.system}.default).";
      }
    ];

    environment.systemPackages = lib.mkIf (package != null) [ package ];

    environment.variables = lib.mkMerge [
      (lib.mkIf cfg.checkTimer.enable {
        TOKENMAXXING_SKIP_TIMER = "1";
      })
      (lib.mkIf cfg.hub.enable {
        TOKENMAXXING_SKIP_HUB = "1";
      })
    ];

    system.activationScripts.extraActivation.text = lib.mkIf ((cfg.checkTimer.enable || cfg.hub.enable) && package != null && home != null && primaryUser != null) (
      lib.mkAfter ''
        sudo -u ${primaryUser} mkdir -p "${home}/.config/tokenmaxxing"
      ''
    );

    launchd.user.agents.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && package != null) {
      command = "${lib.getExe package} check";
      serviceConfig = {
        StartInterval = cfg.checkTimer.intervalSeconds;
        StandardOutPath = "/dev/null";
        StandardErrorPath =
          if home != null then "${home}/.config/tokenmaxxing/check.stderr.log" else "/tmp/tokenmaxxing-check.stderr.log";
      };
    };

    launchd.user.agents.tokenmaxxing-hub = lib.mkIf (cfg.hub.enable && package != null) {
      command = "${lib.getExe package} serve";
      serviceConfig = {
        KeepAlive = {
          SuccessfulExit = false;
        };
        RunAtLoad = true;
        StandardOutPath = "/dev/null";
        StandardErrorPath =
          if home != null then "${home}/.config/tokenmaxxing/hub.stderr.log" else "/tmp/tokenmaxxing-hub.stderr.log";
      };
    };
  };
}
