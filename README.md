# Mattermost for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that connects a bot account of [Mattermost](https://mattermost.com), the
open-source team chat you can host yourself, to Gladys: talk to Gladys in a
direct message, receive the messages of Gladys there, post in Mattermost
channels from your scenes, and start scenes on a message or a command such as
`!lights off`. Works with a server on the local network or on the Internet.

> **Developed without the hardware: feedback welcome.** The integration was
> tested against a real Mattermost server (the
> `mattermost/mattermost-team-edition` Docker image), in both directions, but
> not inside a real Gladys nor with every Mattermost client. Please report what
> works and what does not in the
> [issues](https://github.com/guim31/gladys-mattermost/issues) or on the
> [Gladys forum](https://community.gladysassistant.com).

## Features

- **A two-way chat channel**, like the Telegram bot of Gladys (manifest
  `type: "communication"`, `messaging.receive: true`): each Gladys user links
  their Mattermost account with a code from the Configuration screen, then
  talks to Gladys in a direct message with the bot. The answers of Gladys, the
  _Send Message_ scene action and the system messages arrive there; camera
  images arrive as images.
- **Allowed people only**: the bot ignores the messages of everyone who is not
  in the list of usernames, which is empty by default. Gladys never answers in
  a channel or a group message, where others can read.
- **Scene triggers**: _Mattermost message received_ (in a watched channel,
  filtered by channel and sender), _Mattermost command received_ (prefix +
  word, e.g. `!garage close`, with the arguments as a variable), _Mattermost
  connection lost_, _Mattermost connection restored_.
- **Scene action** _Send a Mattermost message_: Markdown and scene variables,
  to a channel (`team/channel`, its address or its id) or to a person
  (`@alice`). Outputs: sent, post id, error.
- **Dashboard widget** _Mattermost_: connection, bot account, watched
  channels, the last messages of the watched channels, a _Test the connection_
  button.
- Real time over the WebSocket of Mattermost, automatic reconnection, and the
  messages of the last 5 minutes read back after a cut.
- Four languages (English, French, German, Spanish).

Compared with [Apprise for Gladys](https://github.com/guim31/gladys-apprise),
which sends notifications to Mattermost among 100 other services, this
integration also receives: conversations with Gladys, commands and triggers.
It follows the design of [Matrix for Gladys](https://github.com/guim31/gladys-matrix).

## Requirements

- Gladys Assistant **5.1.0** or later.
- A Mattermost server Gladys can reach, and a bot account (or a dedicated
  user with a personal access token) added to your team.

## Installation

In Gladys: **Integrations → Install from GitHub**, then enter
`https://github.com/guim31/gladys-mattermost`. Fill in the server address, the
bot token and the allowed people, click **Test the connection**, then each
user links their account. The full documentation is in
[docs/en.md](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

- REST API v4 with the bot token (`Authorization: Bearer`): `GET /users/me`,
  `POST /users/usernames` (the allowed people, by username, kept by id),
  `GET /teams/name/{team}/channels/name/{channel}`,
  `GET|POST /channels/{id}/members` (the bot joins a public watched channel),
  `POST /channels/direct`, `POST /posts`, `POST /files` (camera images),
  `GET /channels/{id}/posts?since=` (catch-up after a cut). A 429 is honored.
- WebSocket `/api/v4/websocket`, authenticated by `authentication_challenge`,
  with a ping every 30 s: the `posted` events bring every new message the bot
  can see. Node's built-in WebSocket: no dependency but the Gladys SDK.
- Watched channels fire the triggers only; a direct message (`channel_type`
  `D`) from an allowed person is a conversation with Gladys (`linkContact`,
  `publishMessage`, `onSendMessage`); anything else is ignored. The bot's own
  posts and system messages are ignored, so a scene answering a message
  cannot loop.

## Limits

- Text only: files, images and voice messages sent to the bot are ignored.
- Threads are read as ordinary messages; the answers are not threaded.
- One bot account per Gladys. Messages missed during a cut longer than
  5 minutes are skipped.

## Development

```bash
npm install
npm test            # node --test, against the fake Gladys of the SDK and a fake Mattermost
npm run lint
npm run format:check
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

## Credits

- The [Mattermost API reference](https://developers.mattermost.com/api-documentation/)
  (REST v4 and WebSocket). The test fixtures are answers recorded from a real
  Mattermost Team Edition server running in Docker (ids and tokens replaced).
- The [Home Assistant `mattermost` integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/mattermost)
  (Apache-2.0), built on [mattermostdriver](https://github.com/Vaelor/python-mattermost-driver)
  (MIT): the shape of the configuration (server, token, channel). No code was
  copied.
- The logo on the cover is the Mattermost logo from
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Mattermost_logo_horizontal.svg)
  (public domain, from the Mattermost brand guidelines; a trademark of
  Mattermost, Inc.), recolored white.
- The architecture, the `/data` store and the quiet logs come from
  [gladys-matrix](https://github.com/guim31/gladys-matrix); the tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by Mattermost, Inc.
Mattermost is a trademark of Mattermost, Inc.

## License

Apache-2.0
