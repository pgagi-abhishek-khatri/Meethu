{
  description = "Meethu – privacy-first voice dictation, meeting transcription & notes";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          meethu = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = meethu;
          meethu = meethu;
        }
      );

      overlays.default = _final: _prev: {
        meethu = self.packages.x86_64-linux.meethu;
      };

      nixosModules.default = import ./nix/module.nix self;
    };
}
