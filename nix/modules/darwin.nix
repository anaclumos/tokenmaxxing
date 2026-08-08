# nix-darwin module. Import via this flake's `darwinModules.default`.
#
#   {
#     inputs.tokenmaxxing.url = "github:anaclumos/tokenmaxxing";
#     # ...
#     modules = [
#       inputs.tokenmaxxing.darwinModules.withOverlay
#       { programs.tokenmaxxing.enable = true; }
#     ];
#   }
#
# Puts `tokenmaxxing` / `xx` on PATH. Account import, the on-PATH `claude`
# supervisor shim, settings.json hooks, and (by default) the check timer still
# come from `tokenmaxxing init` - Nix cannot own those (credentials + merge
# into user-owned settings).
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

    # Keep init from writing a second imperative timer when Nix owns it.
    environment.variables = lib.mkIf cfg.checkTimer.enable {
      TOKENMAXXING_SKIP_TIMER = "1";
    };

    launchd.user.agents.tokenmaxxing-check = lib.mkIf (cfg.checkTimer.enable && package != null) {
      command = "${lib.getExe package} check";
      serviceConfig = {
        StartInterval = cfg.checkTimer.intervalSeconds;
        StandardOutPath = "/dev/null";
        # Per-user log (not shared /tmp) so multi-user Macs do not collide.
        StandardErrorPath =
          if home != null then "${home}/.config/tokenmaxxing/check.stderr.log" else "/tmp/tokenmaxxing-check.stderr.log";
      };
    };
  };
}
