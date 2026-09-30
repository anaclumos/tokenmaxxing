{
  config,
  lib,
  ...
}:
let
  cfg = config.programs.tokenmaxxing;
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
    environment.systemPackages = [ cfg.package ];

    environment.variables = lib.mkMerge [
      (lib.mkIf cfg.checkTimer.enable {
        TOKENMAXXING_SKIP_TIMER = "1";
      })
      (lib.mkIf cfg.hub.enable {
        TOKENMAXXING_SKIP_HUB = "1";
      })
    ];

    system.activationScripts.extraActivation.text = lib.mkIf ((cfg.checkTimer.enable || cfg.hub.enable) && home != null && primaryUser != null) (
      lib.mkAfter ''
        sudo -u ${primaryUser} mkdir -p "${home}/.config/tokenmaxxing"
      ''
    );

    launchd.user.agents.tokenmaxxing-check = lib.mkIf cfg.checkTimer.enable {
      command = "${lib.getExe cfg.package} check";
      serviceConfig = {
        StartInterval = cfg.checkTimer.intervalSeconds;
        StandardOutPath = "/dev/null";
        StandardErrorPath =
          if home != null then "${home}/.config/tokenmaxxing/check.stderr.log" else "/tmp/tokenmaxxing-check.stderr.log";
      };
    };

    launchd.user.agents.tokenmaxxing-hub = lib.mkIf cfg.hub.enable {
      command = "${lib.getExe cfg.package} serve";
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
