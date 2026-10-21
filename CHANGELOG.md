# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-21

### Added

- Talk to Gladys from Mattermost: each Gladys user links their Mattermost
  account with a code, then writes to the bot in a direct message; the answers
  of Gladys, the _Send Message_ scene action and the system messages arrive
  there, camera images included.
- A list of allowed people (usernames): the bot ignores everyone else. Empty by
  default.
- Watched channels and the _Mattermost message received_ and _Mattermost
  command received_ triggers (`!lights off`: command `lights`, arguments
  `off`).
- The _Send a Mattermost message_ scene action, to a channel (`team/channel`,
  its address or its id) or to a person (`@alice`), with the outputs sent,
  post id and error.
- The _Mattermost connection lost_ and _Mattermost connection restored_
  triggers, and the connection status of the Configuration screen.
- The _Mattermost_ dashboard widget and the _Test the connection_ action.
- Real-time messages over the WebSocket of Mattermost, automatic
  reconnection, and the messages of the last 5 minutes read back after a cut.
- English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-mattermost/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-mattermost/releases/tag/v1.0.0
