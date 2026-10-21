# Mattermost

Talk to Gladys from [Mattermost](https://mattermost.com), the open-source team chat you can host yourself,
the way the Telegram bot of Gladys works: ask a question, run a scene, receive the messages of Gladys in a
direct message. The integration also posts in Mattermost channels from your scenes, and starts scenes when
a message or a command such as `!lights off` is written in a channel it watches. It uses a bot account of
your Mattermost server, on the local network or on the Internet.

> **Developed without the hardware: feedback welcome.** The integration was tested against a real
> Mattermost server (Team Edition, in Docker), but not inside a real Gladys nor with every Mattermost
> client. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-mattermost/issues) or on the
> [Gladys forum](https://community.gladysassistant.com).

## What you need

- Gladys Assistant **5.1.0** or later.
- A Mattermost server Gladys can reach (version 7 or later), and an administrator account to create the
  bot.
- A **bot account** (or a dedicated user with a personal access token). Do not use your personal account:
  the bot answers in its name.
- The username of each person allowed to talk to the bot, such as `alice`.

## Set up

1. In Mattermost, **System Console → Integrations → Bot Accounts**: turn on **Enable Bot Account
   Creation**.
2. Product menu **Integrations → Bot Accounts → Add Bot Account**: a username such as `gladys`, the role
   **Member**. Copy the **token** shown once at the end.
3. Add the bot to your team (team menu **Add members**, or **System Console → Users**).
4. In Gladys, **Integrations → Mattermost → Configuration**:
   - **Server address**: the address of Mattermost as in the browser, for example
     `https://chat.example.org` or `http://192.168.1.20:8065`.
   - **Bot token**: the token of step 2.
   - **Allowed people**: the usernames the bot listens to, separated by commas (`alice, bob`). **Empty,
     the bot answers nobody**: it ignores the messages of everyone who is not in this list.
   - **Watched channels**: the channels whose messages start scenes, written `team/channel` as in their
     address (`https://chat.example.org/home/channels/garage` gives `home/garage`; the whole address is
     accepted too), or by channel id, separated by commas. The bot joins the public channels by itself;
     add it to the private ones first.
   - **Command prefix**: `!` by default (`/` is taken by the slash commands of Mattermost).
   - **Language of the bot**: the language of what the bot writes before a person is linked.
5. Click **Test the connection**: the report gives the account of the bot, the watched channels it joined
   and the allowed people it found. The connection status of the page says it too, and names a channel or
   a person that was not found.

### Link your Mattermost account to talk to Gladys

Each Gladys user who wants to talk to Gladys from Mattermost does it once:

1. In Gladys, **Integrations → Mattermost → Configuration**, block "Link my account": click **Generate a
   link code**.
2. In Mattermost, open a **direct message** with the bot (the **+** next to "Direct Messages", then its
   username) and send it the code (8 characters). The bot confirms: your Mattermost account is linked to
   your Gladys user. You can unlink it from the same block.

## What the bot does

- **In a direct message** with an allowed person: it passes the messages to Gladys, with the authority of
  the linked Gladys user, exactly like the Telegram bot: "What is the temperature in the living room?",
  "Turn off the lights". The answers of Gladys come back in this direct message, Markdown rendered by
  Mattermost. The messages Gladys sends to you (the **Send Message** scene action, the system messages)
  arrive there too, even before any conversation. A camera image sent by a scene arrives as an image.
- **In a watched channel**: every message of an allowed person starts the **Mattermost message received**
  trigger, and a message starting with the prefix also starts **Mattermost command received**. The bot
  never answers there by itself: what happens is up to your scenes.
- **In any other channel** (a group message, a channel that is not watched): it stays silent. Gladys
  never answers where others can read.
- **What it ignores**: everyone who is not an allowed person, its own messages (a scene that posts in a
  watched channel never starts itself again), the system messages ("joined the channel"), edits, and the
  messages older than 5 minutes when it reads them (a "!open garage" from two hours ago does not run now).
- **After a cut** (a restart of the server, of Gladys, a network blip): it reconnects by itself, and reads
  back the messages of the watched channels and of the direct messages posted in the last 5 minutes.

## Dashboard

The **Mattermost** widget shows whether the bot is connected, its account, the watched channels it is in,
the last 5 messages received in the watched channels (author, text, date) and a **Test the connection**
button. The direct messages with Gladys are never shown: everyone who sees the dashboard sees the widget.

## Scenes

### Triggers

- **Mattermost message received**: an allowed person wrote in a watched channel. Filters (empty = any):
  **Channel** (written as in the configuration, for example `home/garage`) and **Sender** (the username,
  without `@`: `alice`). Variables: Message, Sender, Channel, Channel id.
- **Mattermost command received**: an allowed person wrote a command in a watched channel: the prefix,
  then a word, then optional arguments, for example `!lights off kitchen`. Filter **Command**: the word
  **without the prefix, in lower case** (`lights`); and Channel, Sender. Variables: Command (`lights`),
  Arguments (`off kitchen`), Message, Sender, Channel, Channel id. The same message also starts
  **Mattermost message received**.
- **Mattermost connection lost**: the bot cannot reach the server any more, for a minute, or its token is
  refused. Variable: Error. Started once, until the connection comes back.
- **Mattermost connection restored**: the bot reaches the server again after a lost connection. Variable:
  Bot account (username).

### Actions

- **Send a Mattermost message**: posts a message in a channel (`team/channel`, its address or its id), or
  to a person in a direct message (`@alice`). The message accepts the scene variables and the Markdown of
  Mattermost (`**bold**`, `_italic_`, lists, links, `@here`). The bot must be in the channel, or be able to
  join it (a public channel of its team). Results: Sent (yes/no), Post id, Error. A failed message does
  not stop the scene: test **Sent** with a condition if needed.

To write to one Gladys user, the **Send Message** action of Gladys also works: it reaches their linked
Mattermost account.

### Scene ideas

- **Garage by command**: trigger **Mattermost command received**, command `garage`, channel
  `home/garage`; then a condition on the variable Arguments equal to `close`, and the action that closes
  the garage.
- **Washing machine done**: when the power of the washing machine plug drops, **Send a Mattermost
  message** to `home/family`: "The washing machine is done @here".
- **Alert when the bot is cut off**: trigger **Mattermost connection lost**, then a notification through
  another channel (Gotify, ntfy, SMS) with the Error variable.

## Troubleshooting

- **"no Mattermost server at this address"**: use the address you open Mattermost with in a browser,
  without `/login` nor the team. `https://<address>/api/v4/system/ping` must answer `{"status":"OK"…}`.
- **"access token refused"**: the token was revoked, or the bot account deactivated. Create a new token in
  **Integrations → Bot Accounts**.
- **A watched channel is not joined**: the status of the page and the test name it. Check the team and
  the channel names in the address of the channel, add the bot to the team, and to the channel if it is
  private, then save the configuration again.
- **The bot does not answer me**: is your username in **Allowed people**, written exactly? Do you write
  to it in a direct message (not in a group message)? Is your account linked (the bot then gives you the
  instructions)?
- **A command does not start the scene**: the Command filter is the word without the prefix, in lower
  case: `lights`, not `!Lights`.
- **Behind a reverse proxy**, the WebSocket (`/api/v4/websocket`) must be forwarded too, as for the
  Mattermost apps.
- More details in the logs of the integration with `LOG_LEVEL=debug`.

## Limits

- A person linked to Gladys can do from Mattermost everything their Gladys user can do: keep the list of
  allowed people short, and keep the token of the bot secret.
- One bot account per Gladys. The bot reads the messages over the WebSocket of Mattermost: a command takes
  effect in about a second. Messages missed during a cut longer than 5 minutes are skipped.
- Files, images and voice messages sent to the bot are ignored; only text counts. Threads are read as
  ordinary messages, and the answers of Gladys are not posted in the thread.
- The bot uses the API rate limits of the server (10 requests per second per account by default): keep the
  messages of your scenes reasonable.
- Not affiliated with Mattermost, Inc. Mattermost is a trademark of Mattermost, Inc.
