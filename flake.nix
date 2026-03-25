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
          ];

          shellHook = ''
            echo "claude-voice dev shell ready"
            echo "  node: $(node --version)"
            echo "  python: $(python3 --version)"
            echo "  uv: $(uv --version)"
          '';
        };
      });
}
