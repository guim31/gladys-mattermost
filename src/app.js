// -----------------------------------------------------------------------------
// The integration: a Mattermost bot account wired to Gladys.
//
// - A connection loop: the REST API (who am I, the allowed people, the watched
//   channels), then the WebSocket, which pushes every new post the bot can
//   see. After a cut, the posts of the last minutes are read back by REST.
//   Only the people of the "allowed" list are ever answered or obeyed.
// - Watched channels (configuration): every message fires `message_received`,
//   a message starting with the command prefix also fires `command_received`.
// - A direct message from an allowed person is a conversation with Gladys
//   (manifest `type: "communication"`): a link code links the Mattermost
//   account to a Gladys user, then the messages go to the brain
//   (publishMessage) and the answers come back through onSendMessage.
// - Any other channel is ignored: Gladys never answers where others can read.
// - Scene action `send_message`: a message in a channel, or to a person.
// - Triggers `connection_lost` / `connection_restored`, the connection status
//   of the Configuration screen, the widget and the `test_connection` action.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseChannel, parseServer, parseUsername } from './config.js';
import {
  ERROR_KINDS,
  MAX_POST_LENGTH,
  MattermostClient,
  MattermostError,
  TRANSIENT_KINDS,
} from './mattermost/client.js';
import { openSocket } from './mattermost/socket.js';
import { createFailureLog } from './log.js';
import { Store } from './store.js';
import {
  BOT_TEXT,
  PARTIAL_STATUS,
  REPORT_TEXT,
  each,
  errorText,
  errorTexts,
  pick,
} from './texts.js';
import { CONNECTION, TEST_ACTION, WIDGET_KEY, buildWidgetContent } from './widgets.js';

const logger = createLogger({ name: 'mattermost' });

export const ACTION_KEY = 'test_connection';
export const SCENE_ACTION_KEY = 'send_message';
export const TRIGGERS = {
  MESSAGE: 'message_received',
  COMMAND: 'command_received',
  LOST: 'connection_lost',
  RESTORED: 'connection_restored',
};

// Messages older than this when the bot reads them (missed while Gladys or
// the container was down) are skipped: a "!open garage" from two hours ago
// must not run now.
export const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;
// The connection is declared lost after failures lasting this long, never on one blip.
export const LOST_AFTER_MS = 60 * 1000;
export const RETRY_DELAYS_MS = [2000, 5000, 10_000, 30_000, 60_000];
// A refused token: retry slowly, in case the server was the cause.
export const CREDENTIALS_RETRY_MS = 5 * 60 * 1000;
export const RECENT_KEPT = 5;
// Post ids already handled: the WebSocket and the catch-up may both bring one.
const SEEN_KEPT = 200;
const SEEN_SAVED = 50;
// Gladys waits 5 s for the ack of a message: answer before, even if the server is slow.
export const MESSAGE_TIMEOUT_MS = 4500;
// How long a message of Gladys waits for the first connection, within that deadline.
export const CONNECT_WAIT_MS = 2000;
// The "last seen alive" time is written to /data at most this often.
const ALIVE_SAVE_MS = 60 * 1000;
// Gladys link codes: 8 characters of an alphabet without 0/O/1/I/L.
const LINK_CODE = /^[A-HJ-KM-NP-Z2-9]{8}$/i;
const MAX_TEXT_LENGTH = 4096; // the limit of publishMessage

const fingerprint = (...parts) =>
  createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/** Parses a command: "!lights off" → { command: "lights", args: "off" }. */
export function parseCommand(text, prefix) {
  if (!text.startsWith(prefix)) {
    return null;
  }
  const rest = text.slice(prefix.length);
  const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  return { command: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Parses an image of Gladys (a camera): "image/jpg;base64,..." (data: optional). */
export function parseImage(file) {
  if (typeof file !== 'string') {
    return null;
  }
  const match = file.match(/^(?:data:)?(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) {
    return null;
  }
  // Gladys writes image/jpg: the registered type is image/jpeg.
  const contentType =
    match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = contentType.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*$/, '');
  return { buffer, contentType, extension };
}

const clipPost = (text) =>
  text.length > MAX_POST_LENGTH ? `${text.slice(0, MAX_POST_LENGTH - 1)}…` : text;

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [options] replaced by the tests
 * @param {typeof fetch} [options.fetch]
 * @param {typeof WebSocket} [options.WebSocket]
 * @param {{ load(): Promise<object>, save(data: object): Promise<void>, flush(): Promise<void> }} [options.store]
 * @param {() => number} [options.now] milliseconds
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.sleep]
 * @param {number} [options.pingIntervalMs]
 */
export function registerHandlers(gladys, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    store = new Store(),
    now = () => Date.now(),
    pingIntervalMs,
    sleep = (ms, signal) =>
      new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  } = options;

  let data = {}; // persisted: see save()
  const loaded = store.load().then((stored) => {
    data = stored ?? {};
    seen = new Set(Array.isArray(data.seen) ? data.seen : []);
  });

  let config = normalizeConfig({});
  let client = null;
  let me = null; // the bot account: { id, username }
  let configError = new MattermostError(ERROR_KINDS.NOT_CONFIGURED, 'Not configured yet');
  let connection = CONNECTION.NOT_CONFIGURED;
  let lastError = null;
  let watched = new Map(); // channel id → the entry typed in the configuration
  let allowed = new Map(); // user id → username, for the allowed people found
  let failures = []; // channels and people of the configuration not found or not joined
  let controller = null; // aborts the running loop
  let running = null; // the running loop
  let stopped = false;
  let lastStatus = null;
  let connectionKey = null; // server and token of the applied configuration
  let lostFired = false; // connection_lost was fired: connection_restored may follow
  let applying = Promise.resolve(); // configurations are applied one at a time
  let readyWaiters = []; // onSendMessage calls waiting for the first connection
  let lastAliveSave = 0;
  let seen = new Set(); // ids of the posts already handled, persisted (data.seen)
  const statusLog = createFailureLog(logger, { recovered: 'Connection status published again' });
  const socketLog = createFailureLog(logger, { recovered: 'Mattermost connection works again' });
  const brainLog = createFailureLog(logger, { recovered: 'Messages reach Gladys again' });

  function save() {
    return store.save(data);
  }

  // --- Gladys side effects, never fatal --------------------------------------

  async function publishStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === lastStatus || !gladys.connected) {
      return;
    }
    try {
      await gladys.setConnectionStatus(connected, message);
      lastStatus = key;
      statusLog.ok();
    } catch (err) {
      statusLog.fail(`Cannot publish the connection status: ${err.message}`);
    }
  }

  async function fire(key, payload) {
    try {
      await gladys.publishSceneEvent(key, payload);
    } catch (err) {
      logger.warn(`Cannot fire the "${key}" trigger: ${err.message}`);
    }
  }

  function refreshWidget() {
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested: ${err.message}`);
    }
  }

  function setConnection(next) {
    if (connection !== next) {
      connection = next;
      refreshWidget();
    }
  }

  // --- Connection ----------------------------------------------------------------

  /** Resolves a channel of the configuration or of a scene to its id. */
  async function resolveChannel(entry, signal) {
    const parsed = parseChannel(entry);
    if (!parsed) {
      throw new MattermostError(ERROR_KINDS.NOT_FOUND, `Not a channel: ${entry}`);
    }
    if (parsed.id) {
      return parsed.id;
    }
    return (await client.channelByName(parsed.team, parsed.name, { signal })).id;
  }

  /** Makes sure the bot is in the channel: it joins a public channel of its teams. */
  async function ensureMember(channelId, signal) {
    if (!(await client.isMember(channelId, me.id, { signal }))) {
      await client.addMember(channelId, me.id, { signal });
      return true;
    }
    return false;
  }

  /** Checks the token, then finds the allowed people and the watched channels. */
  async function connect(signal) {
    const account = fingerprint(client.base.href, config.access_token);
    if (data.account !== account) {
      // Another server or another token: nothing stored applies any more.
      data = { account, recent: data.recent ?? [] };
      await save();
    }
    const user = await client.me({ signal });
    me = { id: user.id, username: user.username };
    const missing = [];

    const users = await client.usersByUsernames(config.allowed_users, { signal });
    allowed = new Map(
      users
        .filter((found) => found.id !== me.id && !found.delete_at)
        .map((found) => [found.id, found.username]),
    );
    for (const name of config.allowed_users) {
      if (![...allowed.values()].includes(name)) {
        missing.push(`@${name}`);
        logger.warn(`Allowed person @${name} not found on the server`);
      }
    }

    const channels = new Map();
    for (const entry of config.channels) {
      try {
        const channelId = await resolveChannel(entry, signal);
        if (await ensureMember(channelId, signal)) {
          logger.info(`Joined the watched channel ${entry}`);
        }
        channels.set(channelId, entry);
      } catch (err) {
        if (signal.aborted || TRANSIENT_KINDS.has(err.kind)) {
          throw err;
        }
        missing.push(entry);
        logger.warn(`Cannot watch the channel ${entry}: ${err.message}`);
      }
    }
    watched = channels;
    failures = missing;
  }

  const partialStatus = () =>
    failures.length > 0 ? each(PARTIAL_STATUS, (text) => text(failures.join(', '))) : undefined;

  async function markConnected() {
    lastError = null;
    setConnection(CONNECTION.CONNECTED);
    readyWaiters.splice(0).forEach((wake) => wake());
    await publishStatus(true, partialStatus());
    if (lostFired) {
      lostFired = false;
      logger.info('Mattermost connection restored');
      await fire(TRIGGERS.RESTORED, { user: me?.username ?? '' });
    }
  }

  /** Resolves once the bot is connected, or after `ms` at most. */
  function whenConnected(ms) {
    if (me && connection === CONNECTION.CONNECTED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((waiter) => waiter !== wake);
        resolve();
      }, ms);
      readyWaiters.push(wake);
    });
  }

  function alive() {
    const time = now();
    data.lastSeen = time;
    if (time - lastAliveSave >= ALIVE_SAVE_MS) {
      lastAliveSave = time;
      save();
    }
  }

  // --- The connection loop -------------------------------------------------------

  async function loop(signal) {
    let failingSince = null;
    let attempt = 0;
    if (connection !== CONNECTION.DISCONNECTED) {
      // A reconnection after a cut keeps "connected" until the loss is declared.
      setConnection(CONNECTION.CONNECTING);
    }
    while (!signal.aborted) {
      try {
        await connect(signal);
        const since = data.lastSeen;
        const socket = await openSocket({
          url: client.websocketUrl(),
          token: config.access_token,
          WebSocket: WebSocketImpl,
          signal,
          onEvent: (event) => {
            handleEvent(event).catch((err) => logger.warn(`Event not handled: ${err.message}`));
          },
          onAlive: alive,
          ...(pingIntervalMs ? { pingIntervalMs } : {}),
        });
        const openedAt = now();
        const before = { failingSince, attempt };
        failingSince = null;
        attempt = 0;
        socketLog.ok();
        if (connection !== CONNECTION.CONNECTED) {
          logger.info(`Connected to Mattermost as @${me.username}`);
        } else {
          logger.debug(`Reconnected to Mattermost as @${me.username}`);
        }
        await markConnected();
        // Read back what was posted while the socket was down (a cut, a restart).
        if (since) {
          await catchUp(since, signal);
        }
        const reason = await socket.closed;
        if (signal.aborted) {
          return;
        }
        if (now() - openedAt < LOST_AFTER_MS && before.failingSince !== null) {
          // A socket closed right after it opened: the failure goes on, never a busy loop.
          ({ failingSince, attempt } = before);
        }
        throw new MattermostError(ERROR_KINDS.UNREACHABLE, `WebSocket closed (${reason})`);
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        const error =
          err instanceof MattermostError
            ? err
            : new MattermostError(ERROR_KINDS.SERVER, err.message);
        const transient = TRANSIENT_KINDS.has(error.kind);
        lastError = error;
        let delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        if (!transient) {
          // The configuration is wrong: say it, and retry slowly in case the server is the cause.
          delay = CREDENTIALS_RETRY_MS;
        } else if (error.kind === ERROR_KINDS.RATE_LIMITED && error.retryAfterMs > delay) {
          delay = error.retryAfterMs;
        }
        failingSince ??= now();
        socketLog.fail(`Mattermost connection failed: ${error.message}`);
        if (!transient || now() - failingSince >= LOST_AFTER_MS) {
          if (connection !== CONNECTION.DISCONNECTED) {
            const wasConnected = connection === CONNECTION.CONNECTED;
            setConnection(CONNECTION.DISCONNECTED);
            logger.warn(`Mattermost connection lost: ${error.message}`);
            if (wasConnected) {
              lostFired = true;
              await fire(TRIGGERS.LOST, { error: errorText(error, config.language) });
            }
          }
          await publishStatus(false, errorTexts(error));
        }
        await sleep(delay, signal);
      }
    }
  }

  /** Handles the posts of the watched channels and the direct messages since `since`. */
  async function catchUp(since, signal) {
    // 30 s of overlap for a server clock behind ours; the ids already handled are skipped.
    const from = Math.max(
      Math.min(since, data.lastPostAt ?? since) - 30_000,
      now() - MAX_MESSAGE_AGE_MS,
    );
    const channels = new Map([...watched.keys()].map((id) => [id, 'O']));
    for (const channelId of Object.values(data.contactChannels ?? {})) {
      channels.set(channelId, 'D');
    }
    for (const [channelId, type] of channels) {
      try {
        const posts = await client.postsSince(channelId, from, { signal });
        for (const post of posts) {
          if (post.create_at >= from && !post.delete_at) {
            await handlePost(post, type);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        logger.debug(`Missed posts of ${channelId} not read: ${err.message}`);
      }
    }
  }

  async function handleEvent(event) {
    if (event.event !== 'posted' || typeof event.data?.post !== 'string') {
      return;
    }
    let post;
    try {
      post = JSON.parse(event.data.post);
    } catch {
      return;
    }
    await handlePost(post, event.data.channel_type);
  }

  /**
   * One post, from the WebSocket or the catch-up.
   * @param {object} post a Mattermost post
   * @param {string} channelType O (public), P (private), D (direct), G (group)
   */
  async function handlePost(post, channelType) {
    if (!post || typeof post.id !== 'string' || seen.has(post.id)) {
      return;
    }
    seen.add(post.id);
    if (seen.size > SEEN_KEPT) {
      seen.delete(seen.values().next().value);
    }
    data.seen = [...seen].slice(-SEEN_SAVED);
    if (Number.isFinite(post.create_at) && post.create_at > (data.lastPostAt ?? 0)) {
      data.lastPostAt = post.create_at; // the clock of the server
    }
    save();
    if (!me || post.user_id === me.id) {
      return; // its own posts: no loop between a scene and its triggers
    }
    if (!allowed.has(post.user_id)) {
      logger.debug(`Post ${post.id} ignored: not from an allowed person`);
      return;
    }
    if (post.type) {
      return; // a system message (joined the channel, header changed...)
    }
    const props = post.props ?? {};
    if (
      [props.from_webhook, props.from_bot, props.from_plugin].some(
        (v) => v === true || v === 'true',
      )
    ) {
      // Written by a webhook, a bot or a plugin in the name of the person: not the person.
      logger.debug(`Post ${post.id} ignored: from a webhook, a bot or a plugin`);
      return;
    }
    if (post.create_at < now() - MAX_MESSAGE_AGE_MS) {
      logger.debug(`Post ${post.id} skipped: too old`);
      return;
    }
    const text = typeof post.message === 'string' ? post.message.trim() : '';
    if (text === '') {
      return;
    }
    const sender = allowed.get(post.user_id);
    try {
      if (watched.has(post.channel_id)) {
        await handleChannelMessage(post, sender, text);
      } else if (channelType === 'D') {
        // A direct channel holds two people: the bot and this allowed person.
        await handleConversation(post, sender, text);
      } else {
        logger.debug(`Post ${post.id} ignored: neither a watched channel nor a direct message`);
      }
    } catch (err) {
      logger.warn(`Post ${post.id} not handled: ${err.message}`);
    }
  }

  async function handleChannelMessage(post, sender, text) {
    const channel = watched.get(post.channel_id);
    const at = new Date(post.create_at || now()).toISOString();
    data.recent = [{ channel, sender, text: text.slice(0, 500), at }, ...(data.recent ?? [])].slice(
      0,
      RECENT_KEPT,
    );
    save();
    refreshWidget();
    logger.debug(`Message from @${sender} in ${channel}`);
    const common = {
      channel,
      channel_id: post.channel_id,
      sender,
      text: text.slice(0, 1000),
    };
    await fire(TRIGGERS.MESSAGE, common);
    const command = parseCommand(text, config.command_prefix);
    if (command) {
      await fire(TRIGGERS.COMMAND, {
        ...common,
        command: command.command.slice(0, 1000),
        arguments: command.args.slice(0, 1000),
      });
    }
  }

  async function reply(channelId, text) {
    try {
      await client.createPost({ channelId, message: text });
    } catch (err) {
      logger.warn(`Cannot answer in Mattermost: ${err.message}`);
    }
  }

  async function handleConversation(post, sender, text) {
    const userId = post.user_id;
    const channelId = post.channel_id;
    if (data.contactChannels?.[userId] !== channelId) {
      data.contactChannels = { ...data.contactChannels, [userId]: channelId };
      save();
    }
    if (LINK_CODE.test(text)) {
      try {
        const user = await gladys.linkContact(text.toUpperCase(), userId, sender);
        logger.info(`Mattermost account @${sender} linked to a Gladys user`);
        const language = BOT_TEXT[user?.language] ? user.language : config.language;
        await reply(channelId, pick(BOT_TEXT, language).linked(user?.first_name || sender));
        return;
      } catch (err) {
        if (err?.status !== 404) {
          logger.warn(`Cannot link @${sender}: ${err.message}`);
          await reply(channelId, pick(BOT_TEXT, config.language).unavailable);
          return;
        }
        // Not a valid code: maybe a word that looks like one, for the brain.
      }
    }
    try {
      await gladys.publishMessage(userId, text.slice(0, MAX_TEXT_LENGTH), {
        createdAt: new Date(post.create_at || now()),
      });
      brainLog.ok();
      logger.debug(`Message from @${sender} passed to Gladys`);
    } catch (err) {
      if (err?.status === 404) {
        logger.info(`Message from @${sender}, whose account is not linked: instructions sent`);
        await reply(channelId, pick(BOT_TEXT, config.language).notLinked);
        return;
      }
      brainLog.fail(`Cannot pass a message to Gladys: ${err.message}`);
      await reply(channelId, pick(BOT_TEXT, config.language).unavailable);
    }
  }

  // --- Configuration -------------------------------------------------------------

  async function stopLoop() {
    controller?.abort();
    await running;
    controller = null;
    running = null;
  }

  function applyConfig(raw) {
    // Serialized: two saves in a row must never leave two loops running.
    applying = applying.then(() => doApplyConfig(raw));
    return applying;
  }

  async function doApplyConfig(raw) {
    await loaded;
    await stopLoop();
    config = normalizeConfig(raw);
    client = null;
    me = null;
    lastError = null;
    watched = new Map();
    allowed = new Map();
    failures = [];
    const previousKey = connectionKey;
    connectionKey = `${config.server_url}|${config.access_token}`;
    if (connectionKey !== previousKey) {
      lostFired = false; // another server or token: a loss of the old one is not restored here
    }
    const server = parseServer(config.server_url);
    if (!config.server_url) {
      configError = new MattermostError(ERROR_KINDS.NOT_CONFIGURED, 'No server address');
    } else if (!server) {
      configError = new MattermostError(ERROR_KINDS.INVALID_URL, 'Server address not understood');
    } else if (!config.access_token) {
      configError = new MattermostError(ERROR_KINDS.NO_TOKEN, 'No access token');
    } else {
      configError = null;
    }
    if (configError) {
      setConnection(CONNECTION.NOT_CONFIGURED);
      await publishStatus(false, errorTexts(configError));
      return;
    }
    client = new MattermostClient({ server, token: config.access_token, fetch: fetchImpl });
    if (stopped) {
      return;
    }
    controller = new AbortController();
    running = loop(controller.signal).catch((err) => logger.error('Mattermost loop stopped', err));
  }

  function requireConnected() {
    if (!client) {
      throw configError;
    }
    if (!me) {
      throw (
        lastError ?? new MattermostError(ERROR_KINDS.UNREACHABLE, 'Not connected to Mattermost yet')
      );
    }
    return client;
  }

  // --- Sending -------------------------------------------------------------------

  /** The direct channel with a person, known or opened now. */
  async function directChannelOf(userId, signal) {
    const known = data.contactChannels?.[userId];
    if (known) {
      return known;
    }
    const channelId = await requireConnected().directChannel(me.id, userId, { signal });
    data.contactChannels = { ...data.contactChannels, [userId]: channelId };
    save();
    return channelId;
  }

  /**
   * Sends to "@username" (a direct message), a channel id, "team/channel" or
   * the address of a channel, joining a public channel first when needed.
   */
  async function sendTo(target, message) {
    const mattermost = requireConnected();
    let channelId;
    if (target.startsWith('@')) {
      const name = parseUsername(target);
      const [user] = name ? await mattermost.usersByUsernames([name]) : [];
      if (!user) {
        throw new MattermostError(ERROR_KINDS.NOT_FOUND, `Unknown user ${target}`);
      }
      channelId = await directChannelOf(user.id);
    } else {
      channelId = await resolveChannel(target);
    }
    try {
      return await mattermost.createPost({ channelId, message });
    } catch (err) {
      if (err.kind !== ERROR_KINDS.FORBIDDEN || target.startsWith('@')) {
        throw err;
      }
      await mattermost.addMember(channelId, me.id); // a public channel: fails otherwise
      return mattermost.createPost({ channelId, message });
    }
  }

  async function sendImage(channelId, file) {
    const image = parseImage(file);
    if (!image || !client) {
      return;
    }
    try {
      const fileId = await client.uploadFile(
        channelId,
        image.buffer,
        image.contentType,
        `gladys.${image.extension}`,
      );
      await client.createPost({ channelId, message: '', fileIds: [fileId] });
    } catch (err) {
      logger.warn(`Image not sent to Mattermost: ${err.message}`);
    }
  }

  async function testConnection() {
    if (!client) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(configError, lang)));
    }
    try {
      const user = await client.me();
      const lines = (text) => [
        text.connected(user.username),
        config.channels.length > 0
          ? text.channels(watched.size, config.channels.length)
          : text.noChannels,
        config.allowed_users.length > 0
          ? text.users(allowed.size, config.allowed_users.length)
          : text.noUsers,
      ];
      return each(REPORT_TEXT, (text) => lines(text).join(' '));
    } catch (err) {
      return each(REPORT_TEXT, (text, lang) => text.failed(errorText(err, lang)));
    }
  }

  // --- Handlers ------------------------------------------------------------------

  gladys.onSendMessage(async (contact, message) => {
    // Gladys gives up after 5 s: everything below holds in one deadline.
    const deadline = AbortSignal.timeout(MESSAGE_TIMEOUT_MS);
    const contactId = typeof contact?.id === 'string' ? contact.id : '';
    // Right after a start (the "Gladys updated" message), the bot may still be connecting.
    await whenConnected(CONNECT_WAIT_MS);
    if (!me) {
      requireConnected(); // throws: Gladys learns the message was not delivered
    }
    if (!allowed.has(contactId)) {
      // Linked once, then removed from the allowed people: nothing goes out to them.
      logger.debug(
        `Message to ${contactId || 'an unknown contact'} not sent: not an allowed person`,
      );
      return;
    }
    const text = typeof message?.text === 'string' ? message.text : '';
    try {
      const mattermost = requireConnected();
      const channelId = await directChannelOf(contactId, deadline);
      if (text.trim() !== '') {
        await mattermost.createPost({ channelId, message: clipPost(text) }, { signal: deadline });
      }
      if (message?.file) {
        sendImage(channelId, message.file); // after the ack: an upload takes longer than 5 s
      }
    } catch (err) {
      const failure = deadline.aborted
        ? new MattermostError(ERROR_KINDS.TIMEOUT, `No answer within ${MESSAGE_TIMEOUT_MS} ms`)
        : err;
      logger.warn(`Message not delivered to @${allowed.get(contactId)}: ${failure.message}`);
      throw new Error(`Mattermost: ${errorText(failure, 'en')}`, { cause: err });
    }
  });

  gladys.onSceneAction(SCENE_ACTION_KEY, async (fields) => {
    const target = typeof fields?.channel === 'string' ? fields.channel.trim() : '';
    const text = typeof fields?.message === 'string' ? fields.message : '';
    if (target === '' || text.trim() === '') {
      throw new Error('Mattermost: the channel and the message are required');
    }
    try {
      const post = await sendTo(target, clipPost(text));
      logger.info(`Scene message sent to ${target}`);
      return { sent: true, post_id: post.id ?? '', error: '' };
    } catch (err) {
      logger.warn(`Scene message not sent to ${target}: ${err.message}`);
      return { sent: false, post_id: '', error: errorText(err, config.language) };
    }
  });

  gladys.onAction(ACTION_KEY, () => testConnection());

  gladys.onWidgetGet(WIDGET_KEY, async ({ language }) => {
    await loaded;
    return buildWidgetContent(
      {
        connection,
        username: me?.username ?? null,
        channels: { joined: watched.size, total: config.channels.length },
        recent: data.recent ?? [],
      },
      language,
    );
  });

  gladys.onWidgetAction(WIDGET_KEY, async (actionKey) => {
    if (actionKey !== TEST_ACTION) {
      throw new Error(`Unknown widget action "${actionKey}"`);
    }
    const report = await testConnection();
    return each(report, (text) => (text.length > 200 ? `${text.slice(0, 199)}…` : text));
  });

  gladys.onConfigUpdated((raw) => applyConfig(raw));

  gladys.on('connected', () => {
    lastStatus = null; // a new connection: publish the status again
    return applyConfig(gladys.config).catch((err) =>
      logger.error('Cannot apply the configuration', err),
    );
  });

  return {
    get config() {
      return config;
    },
    get connection() {
      return connection;
    },
    get data() {
      return data;
    },
    async stop() {
      stopped = true;
      await stopLoop();
      save();
      await store.flush();
    },
  };
}
