cask "operecs" do
  arch arm: "-arm64", intel: ""

  version "0.22.3"
  sha256 arm:   "d45640e465823bfbeae4a78cfdf3033e0bcdced27e632f71fbbe49ccec02ddb6",
         intel: "80f0c30b9003854843723c55fe6c70ba3bff331ce424b9a449b0561f7ce03851"

  url "https://github.com/ezzeldinzozz-svg/operecs-browser/releases/download/v#{version}/Operecs-#{version}#{arch}.dmg"
  name "Operecs"
  desc "Private, fast web browser built on Chromium"
  homepage "https://github.com/ezzeldinzozz-svg/operecs-browser"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "Operecs.app"

  zap trash: [
    "~/Library/Application Support/Browser",
    "~/Library/Caches/Browser",
    "~/Library/Preferences/com.ezzeddinmagdy.browser.plist",
    "~/Library/Saved Application State/com.ezzeddinmagdy.browser.savedState",
  ]
end
