# Store listings

Ready-made listing files (currently v0.22.3). Bump the version, URLs and SHA-256 sums with each release
(`shasum -a 256 dist/Operecs-<v>-arm64.dmg dist/Operecs-<v>.dmg dist/ci/browser-windows/*.exe`).

## Homebrew (`homebrew/Casks/operecs.rb`)

- The official `homebrew/cask` repo no longer takes apps that fail Gatekeeper (from 2026-09-01),
  and Operecs isn't notarized yet (needs the Apple Developer Program). It also asks for a
  well-known project (stars/forks). So for now: our own tap.
- Own tap (live): the public repo `ezzeldinzozz-svg/homebrew-operecs` with `Casks/operecs.rb`. People install
  with `brew install --cask ezzeldinzozz-svg/operecs/operecs`. macOS still asks "Open Anyway" on
  first launch, like the DMG. `npm run release -- <v> --all-platforms` updates the tap's cask
  itself (version and checksums, from this file as the template).
- After notarization: submit to `homebrew/cask` (`brew bump-cask-pr` keeps it current).

## winget (`winget/manifests/…`)

- A pull request to `microsoft/winget-pkgs` adding `manifests/e/Ezzeddin/Operecs/<version>/`.
  Their bots install the setup in a sandbox and scan it; an unsigned installer is accepted but
  SmartScreen warns users. Check locally first on Windows: `winget validate --manifest <dir>`
  and `winget install --manifest <dir>`.
- Windows builds have never been used by a person (parked), so test them before listing.

## Microsoft Store

- Needs a Partner Center developer account (free for individuals) in the owner's name: reserve the
  name "Operecs" there, which gives the package identity (Identity Name, Publisher CN, Publisher
  display name).
- Then add an `appx` target to electron-builder with those values (`build.appx`), build the
  .appx/.msix on Windows (CI), and upload it in Partner Center. The Store signs MSIX packages, so
  no code-signing certificate is needed for the Store version.
- Store builds must update through the Store: the built-in updater has to be off in that build.
