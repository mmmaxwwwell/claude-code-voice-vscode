{
  description = "claude-voice VS Code extension dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.python311
            pkgs.uv
            pkgs.portaudio
            pkgs.gitleaks
            pkgs.ruff
          ];

          # numpy, onnxruntime, and other pip-installed C extensions need
          # libstdc++ and libz at runtime. Expose them via LD_LIBRARY_PATH.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
            pkgs.stdenv.cc.cc.lib
            pkgs.zlib
          ];

          shellHook = ''
            git config --local core.hooksPath .githooks
            echo "claude-voice dev shell ready"
            echo "  node: $(node --version)"
            echo "  python: $(python3 --version)"
            echo "  uv: $(uv --version)"
            echo "  gitleaks: $(gitleaks version)"
          '';
        };
      });
}
