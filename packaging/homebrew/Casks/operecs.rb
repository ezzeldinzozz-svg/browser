cask "operecs" do
  arch arm: "-arm64", intel: ""

  version "0.22.2"
  sha256 arm:   "609f1d1199277d817e9be8a64544959b2ff4a82c5e7b2568056f00c769125936",
         intel: "117eac4d2d801ddcb6bbc7ef4549b6e4a850fefcb18562993829c26ccaa77dd8"

  url "https://github.com/ezzeldinzozz-svg/operecs-browser/releases/download/v#{version}/Operecs-#{version}#{arch}.dmg"
  name "Operecs"
  desc "Private, fast web browser built on Chromium"
  homepage "https://github.com/ezzeldinzozz-svg/operecs-browser"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "Operecs.app"

  zap trash: [
    "~/Library/Application Support/Browser",
    "~/Library/Caches/Browser",
    "~/Library/Preferences/com.ezzeddinmagdy.browser.plist",
    "~/Library/Saved Application State/com.ezzeddinmagdy.browser.savedState",
  ]
end
