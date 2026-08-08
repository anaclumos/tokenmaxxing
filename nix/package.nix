{
  lib,
  bun2nix,
  stdenv,
}:
# Source-run under Bun (same distribution model as the npm package). Do not
# switch this to bun2nix.mkDerivation/--compile: flock goes through bun:ffi and
# the published artifact is deliberately TypeScript source.
bun2nix.writeBunApplication {
  packageJson = ../package.json;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../bunfig.toml
      ../tsconfig.json
      ../src
    ];
  };

  # Optional platform packages (claude-agent-sdk) and Darwin's preference for
  # symlink installs mirror the bun2nix nextjs template.
  bunInstallFlags = [
    "--cpu=*"
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    "--linker=isolated"
    "--backend=symlink"
  ];

  dontUseBunBuild = true;
  dontUseBunCheck = true;

  # TOKENMAXXING_NIX tells init to write PATH-indirect supervisor shims instead
  # of hardcoding this generation's /nix/store entry (which vanishes on GC /
  # profile upgrade). chdir is the packaged share tree.
  startScript = ''
    export TOKENMAXXING_NIX=1
    exec bun run ./src/main.ts "$@"
  '';

  inheritPath = true;

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };

  postInstall = ''
    ln -s "$out/bin/$pname" "$out/bin/xx"
  '';

  meta = {
    description = "Automatic Claude Code / Codex account switching across pooled subscription logins";
    homepage = "https://github.com/anaclumos/tokenmaxxing";
    license = lib.licenses.mit;
    mainProgram = "tokenmaxxing";
    platforms = lib.platforms.darwin ++ lib.platforms.linux;
  };
}
