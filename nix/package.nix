{
  lib,
  bun2nix,
  stdenv,
}:
bun2nix.writeBunApplication {
  packageJson = ../package.json;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../tsconfig.json
      ../src
    ];
  };

  bunInstallFlags = [
    "--cpu=*"
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    "--linker=isolated"
    "--backend=symlink"
  ];

  dontUseBunBuild = true;
  dontUseBunCheck = true;

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
