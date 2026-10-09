# Privacy

Operecs has no accounts, no telemetry, no analytics and no crash reporting. Your bookmarks,
history, settings and site permissions stay on your computer, in the
browser's profile folder (`~/Library/Application Support/Browser` on macOS; the folder keeps its original name).

## What goes over the network

Besides the websites you visit, Operecs itself contacts:

| What | Where | When | What's sent |
|---|---|---|---|
| Update check | `github.com/ezzeldinzozz-svg/operecs-browser` (GitHub Releases) | At launch and every 6 hours, or when you click Check for updates | A normal web request for the release info and, when there's an update, the update file |
| Ad and tracker block lists | Ghostery's CDN (`cdn.ghostery.com`) | First launch, then about once a week | A normal web request for the lists |
| Your search engine | The one you choose (DuckDuckGo by default) | When you search from the address bar | What you typed |
| Search suggestions (off by default) | Your search engine's suggestion service | Only if you turn on "Show search suggestions": as you type in the address bar (not in private windows) | What you're typing, without cookies |
| Site icons | The site you're visiting | When a page has an icon | A request for the icon, without cookies |

These requests include your IP address and a standard browser user agent, like any web request.

## Private windows

Private windows keep cookies, site data, history, permissions and the download list in memory
only, and erase them when the window closes. Files you download stay on disk.

## Third-party cookies and trackers

By default Operecs blocks third-party cookies and known ads and trackers. You can change both in
Settings. Sites can ask to use their cookies while embedded; you'll be asked first.
