# Home Manager module (macOS or Linux). Import via this flake's
# `homeManagerModules.default`.
#
#   home-manager.users.you = {
#     imports = [ inputs.tokenmaxxing.homeManagerModules.default ];
#     programs.tokenmaxxing.enable = true;
#     programs.tokenmaxxing.package = inputs.tokenmaxxing.packages.''${pkgs.system}.default;
#   };
#
# Same split as the darwin module: Nix installs the CLI; `tokenmaxxing init`
# still owns credentials, the `claude` supervisor shim, and settings merges.
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

    home.packages = [ package ];

    launchd.agents.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && hostPlatform.isDarwin) {
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
      lib.mkIf (cfg.checkTimer.enable && hostPlatform.isLinux)
        {
          Unit.Description = "tokenmaxxing account-switch check";
          Service = {
            Type = "oneshot";
            ExecStart = "${lib.getExe package} check";
          };
        };

    systemd.user.timers.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && hostPlatform.isLinux) {
      Unit.Description = "tokenmaxxing periodic account-switch check";
      Timer = {
        OnBootSec = "60";
        OnUnitActiveSec = toString cfg.checkTimer.intervalSeconds;
        AccuracySec = "30";
        Unit = "tokenmaxxing-check.service";
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };
}
