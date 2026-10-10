# Operecs for Homebrew

Install the [Operecs](https://github.com/ezzeldinzozz-svg/operecs-browser) web browser on a Mac:

```sh
brew tap ezzeldinzozz-svg/operecs
brew trust ezzeldinzozz-svg/operecs
brew install --cask operecs
```

(`brew trust` is Homebrew's step for any tap outside its own catalogue.) Operecs updates itself
after that. Operecs isn't notarized by Apple yet, so the first time you open
it macOS asks: open System Settings → Privacy & Security and click **Open Anyway**.

This tap is updated automatically with each Operecs release.
