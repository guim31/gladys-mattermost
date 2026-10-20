// -----------------------------------------------------------------------------
// The integration end to end: the fake Gladys of the SDK on one side, a fake
// Mattermost (REST and WebSocket) answering like a real one on the other.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import {
  ACTION_KEY,
  CREDENTIALS_RETRY_MS,
  LOST_AFTER_MS,
  MAX_MESSAGE_AGE_MS,
  SCENE_ACTION_KEY,
  TRIGGERS,
  parseCommand,
} from '../src/app.js';
import { WIDGET_KEY } from '../src/widgets.js';
import {
  ALICE_ID,
  BASE_CONFIG,
  BOT_ID,
  FAMILY,
  GARAGE,
  MALLORY_ID,
  START,
  TOKEN,
  createFakeServer,
  createWorld,
  settle,
} from './helpers/world.js';

async function connected(t, options) {
  const world = await createWorld(options);
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'connected');
  return world;
}

/** Alice writes in a channel; the socket delivers it. */
async function say(world, channelId, text, userId = ALICE_ID, extra) {
  const post = world.server.publish(userId, channelId, text, extra);
  await settle();
  return post;
}

/** Opens the direct channel of Alice and the bot, as when she writes to it first. */
async function directChannel(world) {
  const answer = await world.server.fetch('https://chat.test/api/v4/channels/direct', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify([ALICE_ID, BOT_ID]),
  });
  world.server.requests.pop();
  return (await answer.json()).id;
}

const botPosts = (world) => world.server.posts.filter((post) => post.user_id === BOT_ID);

test('not configured: says what is missing, never calls the server', async (t) => {
  const server = createFakeServer();
  const world = await createWorld({ config: {}, server });
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'not_configured');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /address of the Mattermost server/);

  await world.fake.configUpdated({ server_url: 'ftp://chat.test' });
  assert.match(world.fake.connectionStatus.message.fr, /adresse du serveur incomprise/);
  await world.fake.configUpdated({ server_url: 'chat.test' }); // https:// is implied
  assert.match(world.fake.connectionStatus.message.de, /Zugriffstoken des Bot-Kontos/);
  assert.deepEqual(server.requests, []);
});

test('connection: the token checked, the people found, the public channel joined', async (t) => {
  const world = await connected(t);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.ok(world.server.members.get(GARAGE).has(BOT_ID), 'the bot joined home/garage');
  const [socket] = world.server.sockets;
  assert.equal(socket.url, 'wss://chat.test/api/v4/websocket');
  assert.deepEqual(socket.sent[0], {
    seq: 1,
    action: 'authentication_challenge',
    data: { token: TOKEN },
  });
  assert.equal(JSON.stringify(world.store.data).includes(TOKEN), false, 'no token in /data');
});

test('a refused token is said and retried slowly, without a lost trigger', async (t) => {
  const world = await createWorld({ config: { ...BASE_CONFIG, access_token: 'wrong' } });
  t.after(() => world.app.stop());
  assert.equal(world.app.connection, 'disconnected');
  assert.match(world.fake.connectionStatus.message.en, /access token refused/);
  assert.equal(world.sleeps[0].ms, CREDENTIALS_RETRY_MS);
  assert.deepEqual(world.fake.sceneEvents, [], 'never connected: nothing was lost');
});

test('people and channels not found: connected, and the status says which', async (t) => {
  const world = await connected(t, {
    config: { ...BASE_CONFIG, allowed_users: 'alice, @Ghost', channels: 'home/garage home/nope' },
  });
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.match(world.fake.connectionStatus.message.en, /@ghost, home\/nope/);
  const report = await world.fake.action(ACTION_KEY, {});
  assert.equal(
    report.data.message.en,
    'Connected as @gladys. Watched channels joined: 1/2. Allowed people found: 1/2.',
  );
});

test('a message in a watched channel fires the triggers, a command too', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '!Lumieres off salon');
  const common = {
    channel: 'home/garage',
    channel_id: GARAGE,
    sender: 'alice',
    text: '!Lumieres off salon',
  };
  assert.deepEqual(world.fake.sceneEvents, [
    { key: TRIGGERS.MESSAGE, data: common },
    { key: TRIGGERS.COMMAND, data: { ...common, command: 'lumieres', arguments: 'off salon' } },
  ]);
  const widget = await world.fake.widgetGet(WIDGET_KEY, { language: 'en', settings: {} });
  const [card] = widget.data.content.components[1].items;
  assert.equal(card.title, '@alice');
  assert.equal(card.badge.text, 'garage');
  assert.equal(card.date, new Date(START).toISOString());
});

test('the bot obeys nobody else, and skips its own, system and old posts', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, '!garage open', MALLORY_ID);
  await say(world, GARAGE, '!garage open', BOT_ID);
  await say(world, GARAGE, 'alice joined the channel.', ALICE_ID, { type: 'system_join_channel' });
  await say(world, GARAGE, '!garage open', ALICE_ID, {
    create_at: START - MAX_MESSAGE_AGE_MS - 1,
  });
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.deepEqual(world.fake.messages, []);
});

test('a group channel that is not watched is never a conversation with Gladys', async (t) => {
  const world = await connected(t);
  await say(world, FAMILY, 'Turn off the heating');
  assert.deepEqual(world.fake.sceneEvents, []);
  assert.deepEqual(world.fake.messages, []);
  assert.deepEqual(botPosts(world), []);
});

test('direct message: the link code links the account, then messages go to Gladys', async (t) => {
  const world = await connected(t, {
    linkedUser: { selector: 'alice', first_name: 'Alice', language: 'fr' },
  });
  const dm = await directChannel(world);
  await say(world, dm, 'abcd2345');
  assert.equal(world.fake.contacts[0].contact_id, ALICE_ID);
  assert.equal(world.fake.contacts[0].contact_name, 'alice');
  assert.match(botPosts(world)[0].message, /^Bonjour Alice/);
  assert.equal(botPosts(world)[0].channel_id, dm);
  assert.deepEqual(world.fake.sceneEvents, [], 'a direct message fires no trigger');

  await say(world, dm, 'Turn on the kitchen light');
  assert.deepEqual(world.fake.messages, [
    {
      contact_id: ALICE_ID,
      text: 'Turn on the kitchen light',
      created_at: new Date(START).toISOString(),
    },
  ]);

  // The answer of Gladys comes back in the same direct channel, Markdown as is.
  const before = world.server.requests.length;
  const ack = await world.fake.sendMessage(
    { id: ALICE_ID },
    { text: 'It is **21 °C**', file: null },
  );
  assert.equal(ack.success, true);
  const answer = botPosts(world).at(-1);
  assert.equal(answer.channel_id, dm);
  assert.equal(answer.message, 'It is **21 °C**');
  assert.deepEqual(
    world.server.requests.slice(before).map((r) => r.path),
    ['/posts'],
    'the known channel is reused',
  );
});

test('an account not linked yet gets the instructions; Gladys down gets an apology', async (t) => {
  const world = await connected(t);
  const dm = await directChannel(world);
  t.mock.method(world.gladys, 'publishMessage', async () => {
    throw new GladysApiError(404, 'NOT_FOUND', 'CONTACT_NOT_FOUND');
  });
  t.mock.method(world.gladys, 'linkContact', async () => {
    throw new GladysApiError(404, 'NOT_FOUND', 'INVALID_LINK_CODE');
  });
  await say(world, dm, 'Hello');
  assert.match(botPosts(world)[0].message, /Generate a link code/);
  // A wrong code is a message like any other: the same instructions.
  await say(world, dm, 'ZZZZ9999');
  assert.match(botPosts(world)[1].message, /Generate a link code/);

  world.gladys.publishMessage.mock.mockImplementation(async () => {
    throw new GladysApiError(500, 'SERVER_ERROR', 'down');
  });
  await say(world, dm, 'Hello');
  assert.match(botPosts(world)[2].message, /try again later/);
});

test('a message of Gladys to a person without a channel opens the direct one', async (t) => {
  const world = await connected(t);
  await world.fake.sendMessage({ id: ALICE_ID }, { text: 'Backup failed', file: null });
  const [post] = botPosts(world);
  assert.equal(world.server.channels.get(post.channel_id).type, 'D');
  assert.equal(post.message, 'Backup failed');
  assert.equal(world.store.data.contactChannels[ALICE_ID], post.channel_id);

  // A camera image follows the text.
  await world.fake.sendMessage(
    { id: ALICE_ID },
    { text: 'Doorbell', file: 'image/jpg;base64,/9j/4AAQ' },
  );
  await settle();
  assert.deepEqual(world.server.uploads, [
    { channel: post.channel_id, size: 6, type: 'image/jpeg' },
  ]);
  assert.deepEqual(botPosts(world).at(-1).file_ids, ['file1']);
});

test('nothing goes out to a contact who is not, or no longer, an allowed person', async (t) => {
  const world = await connected(t);
  const ack = await world.fake.sendMessage({ id: MALLORY_ID }, { text: 'secret', file: null });
  assert.equal(ack.success, true);
  assert.deepEqual(botPosts(world), []);
});

test('scene action: a channel, a person, and a failure reported as outputs', async (t) => {
  const world = await connected(t);
  let ack = await world.fake.sceneAction(SCENE_ACTION_KEY, {
    channel: 'home/garage',
    message: 'Alarm _on_',
  });
  const [first] = botPosts(world);
  assert.deepEqual(ack.data.outputs, { sent: true, post_id: first.id, error: '' });
  assert.equal(first.channel_id, GARAGE);
  assert.equal(first.message, 'Alarm _on_');
  assert.deepEqual(world.fake.sceneEvents, [], 'its own posts never fire a trigger');

  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: '@Alice', message: 'Hi' });
  assert.equal(ack.data.outputs.sent, true);
  assert.equal(world.server.channels.get(botPosts(world).at(-1).channel_id).type, 'D');

  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: FAMILY, message: 'By id' });
  assert.equal(ack.data.outputs.sent, true);

  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'home/nope', message: 'x' });
  assert.deepEqual(ack.data.outputs, {
    sent: false,
    post_id: '',
    error: 'channel, team or user not found on the server',
  });
  world.server.rejectPosts = true;
  ack = await world.fake.sceneAction(SCENE_ACTION_KEY, { channel: 'home/garage', message: 'x' });
  assert.match(ack.data.outputs.error, /message too long/);
});

test('scene action: a public channel the bot is not in yet is joined first', async (t) => {
  const world = await connected(t, { config: { ...BASE_CONFIG, channels: '' } });
  assert.equal(world.server.members.get(GARAGE).has(BOT_ID), false);
  const ack = await world.fake.sceneAction(SCENE_ACTION_KEY, {
    channel: 'https://chat.test/home/channels/garage',
    message: 'Hello',
  });
  assert.equal(ack.data.outputs.sent, true);
  assert.ok(world.server.members.get(GARAGE).has(BOT_ID));
});

test('connection lost after a minute of failures, restored once it answers again', async (t) => {
  const world = await connected(t);
  world.server.down = 'ECONNREFUSED';
  world.server.dropSockets();
  await settle();
  assert.equal(world.app.connection, 'connected', 'one cut is not a loss');
  let waited = 0;
  while (waited < LOST_AFTER_MS) {
    waited += await world.wake();
  }
  assert.equal(world.app.connection, 'disconnected');
  assert.deepEqual(world.fake.sceneEvents, [
    { key: TRIGGERS.LOST, data: { error: 'the Mattermost server does not answer' } },
  ]);
  assert.equal(world.fake.connectionStatus.connected, false);

  world.server.down = null;
  await world.wake();
  assert.equal(world.app.connection, 'connected');
  assert.deepEqual(world.fake.sceneEvents.at(-1), {
    key: TRIGGERS.RESTORED,
    data: { user: 'gladys' },
  });
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
});

test('after a cut, what was posted meanwhile is read back, once', async (t) => {
  const world = await connected(t);
  const dm = await directChannel(world);
  await say(world, dm, 'first');
  assert.equal(world.fake.messages.length, 1);

  world.server.dropSockets();
  world.clock.time += 1000;
  world.server.publish(ALICE_ID, GARAGE, '!door close'); // no socket open: missed
  await world.wake(); // the reconnection
  assert.equal(world.app.connection, 'connected');
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => event.key),
    [TRIGGERS.MESSAGE, TRIGGERS.COMMAND],
  );
  assert.equal(world.fake.messages.length, 1, 'the direct message handled before is not replayed');
});

test('a socket that stops answering pings is replaced', async (t) => {
  const world = await connected(t, { pingIntervalMs: 20 });
  world.server.muted = true;
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settle();
  world.server.muted = false;
  await world.wake();
  assert.equal(world.server.sockets.length, 2);
  assert.equal(world.app.connection, 'connected');
});

test('test action and widget button: the account, the channels, the people', async (t) => {
  const world = await connected(t);
  const report = await world.fake.action(ACTION_KEY, {});
  assert.equal(
    report.data.message.fr,
    'Connecté en tant que @gladys. Canaux surveillés rejoints : 1/1. Personnes autorisées trouvées : 1/1.',
  );
  const button = await world.fake.widgetAction(
    WIDGET_KEY,
    'test',
    {},
    { settings: {}, values: {} },
  );
  assert.match(button.data.message.en, /^Connected as @gladys/);

  const empty = await createWorld({ config: {} });
  t.after(() => empty.app.stop());
  const failed = await empty.fake.action(ACTION_KEY, {});
  assert.match(failed.data.message.en, /^Connection failed: enter the address/);
});

test('parseCommand: prefix, word in lower case, the rest as arguments', () => {
  assert.deepEqual(parseCommand('!Lights off now', '!'), { command: 'lights', args: 'off now' });
  assert.deepEqual(parseCommand('!ping', '!'), { command: 'ping', args: '' });
  assert.equal(parseCommand('lights off', '!'), null);
  assert.equal(parseCommand('! lights', '!'), null);
});

test('two configurations saved in a row leave one loop, and stop() stops it', async (t) => {
  const world = await connected(t);
  await Promise.all([
    world.fake.configUpdated({ ...BASE_CONFIG }),
    world.fake.configUpdated({ ...BASE_CONFIG, command_prefix: '?' }),
  ]);
  await settle();
  assert.equal(world.server.sockets.filter((socket) => socket.open).length, 1);
  assert.equal(world.app.config.command_prefix, '?');
  await world.app.stop();
  assert.equal(world.server.sockets.filter((socket) => socket.open).length, 0);
});

test('a message of Gladys right after the start waits for the connection', async (t) => {
  const server = createFakeServer();
  const world = await createWorld({ server, config: {} });
  t.after(() => world.app.stop());
  const configured = world.fake.configUpdated(BASE_CONFIG);
  const ack = world.fake.sendMessage({ id: ALICE_ID }, { text: 'Gladys updated', file: null });
  await configured;
  assert.equal((await ack).success, true);
  assert.equal(botPosts(world)[0]?.message, 'Gladys updated');
});

test('the scene data stays within 1000 characters', async (t) => {
  const world = await connected(t);
  await say(world, GARAGE, `!say ${'a'.repeat(3000)}`);
  for (const event of world.fake.sceneEvents) {
    for (const value of Object.values(event.data)) {
      assert.ok(value.length <= 1000);
    }
  }
});
