# Browser

Read `HANDOFF.md` first: it has the project status, architecture, setup, and roadmap.

Rules:
- Update `HANDOFF.md` in the same commit whenever features, architecture, setup, known issues or the roadmap change, and refresh its "Last updated" line.
- Never commit the release signing key (`~/.browser-release/update-private-key.pem`) or any token.
- Push and release as GitHub account `ezzeldinzozz-svg`; commit with its noreply email (see HANDOFF.md).
- Electron is pinned to an exact version; change it deliberately.
