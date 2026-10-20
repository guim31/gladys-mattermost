// -----------------------------------------------------------------------------
// The pieces: configuration parsing, the REST client (typed errors, no token
// in a message), the WebSocket handshake and the widget budget.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseChannel, parseServer } from '../src/config.js';
import { ERROR_KINDS, MattermostClient } from '../src/mattermost/client.js';
import { openSocket } from '../src/mattermost/socket.js';
import { parseImage } from '../src/app.js';
import { CONNECTION, buildWidgetContent } from '../src/widgets.js';
import { TOKEN, createFakeServer, fixture } from './helpers/world.js';

test('normalizeConfig: defaults, lists, usernames without @ in lower case', () => {
  assert.deepEqual(normalizeConfig({}), {
    server_url: '',
    access_token: '',
    allowed_users: [],
    channels: [],
    command_prefix: '!',
    language: 'fr',
  });
  const config = normalizeConfig({
    allowed_users: '@Alice, bob;; alice\nnot#valid',
    channels: ' home/garage , home/garage ',
    command_prefix: 'toolong',
    language: 'it',
  });
  assert.deepEqual(config.allowed_users, ['alice', 'bob']);
  assert.deepEqual(config.channels, ['home/garage']);
  assert.equal(config.command_prefix, '!');
  assert.equal(config.language, 'fr');
});

test('parseChannel: team/channel, the browser address, an id', () => {
  assert.deepEqual(parseChannel('Home/Garage'), { team: 'home', name: 'garage' });
  assert.deepEqual(parseChannel('https://chat.example.org/home/channels/town-square?x=1'), {
    team: 'home',
    name: 'town-square',
  });
  assert.deepEqual(parseChannel('garagegaragegaragegaragega'), {
    id: 'garagegaragegaragegaragega',
  });
  assert.equal(parseChannel('https://chat.example.org/home/messages/@alice'), null);
  assert.equal(parseChannel('garage'), null);
});

test('parseServer: https implied, a sub-path kept, no credentials in the address', () => {
  assert.equal(parseServer('chat.example.org').href, 'https://chat.example.org/');
  assert.equal(parseServer('http://192.0.2.10:8065/').href, 'http://192.0.2.10:8065/');
  assert.equal(parseServer('https://example.org/chat/api/v4').href, 'https://example.org/chat');
  assert.equal(parseServer('https://user:pass@chat.example.org'), null);
  assert.equal(parseServer('ftp://chat.example.org'), null);
  assert.equal(parseServer(''), null);
});

test('client: the WebSocket address follows the server', () => {
  const secure = new MattermostClient({
    server: parseServer('https://example.org/chat'),
    token: 't',
  });
  assert.equal(secure.websocketUrl(), 'wss://example.org/chat/api/v4/websocket');
  const plain = new MattermostClient({ server: parseServer('http://192.0.2.10:8065'), token: 't' });
  assert.equal(plain.websocketUrl(), 'ws://192.0.2.10:8065/api/v4/websocket');
});

test('client: errors are typed and never carry the token', async () => {
  const server = createFakeServer();
  const client = (token, fetch = server.fetch) =>
    new MattermostClient({ server: parseServer('https://chat.test'), token, fetch });
  await assert.rejects(client('wrong-token').me(), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TOKEN);
    assert.equal(err.id, fixture('error-401').id);
    assert.equal(err.message.includes('wrong-token'), false);
    return true;
  });
  await assert.rejects(client(TOKEN).channelByName('home', 'nope'), {
    kind: ERROR_KINDS.NOT_FOUND,
  });
  await assert.rejects(client(TOKEN).request('GET', '/../not-api'), {
    kind: ERROR_KINDS.NOT_MATTERMOST,
  });
  server.down = 'ECONNREFUSED';
  await assert.rejects(client(TOKEN).me(), {
    kind: ERROR_KINDS.UNREACHABLE,
    message: 'Server unreachable: ECONNREFUSED',
  });
  const html = async () => new Response('<html></html>', { status: 200 });
  await assert.rejects(client(TOKEN, html).me(), { kind: ERROR_KINDS.NOT_MATTERMOST });
});

test('client: a short 429 is waited for once, then the call goes through', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"id":"api.rate_limit","message":"limit"}', {
          status: 429,
          headers: { 'x-ratelimit-reset': '0.01' },
        })
      : new Response(JSON.stringify(fixture('users-me')), { status: 200 });
  };
  const client = new MattermostClient({
    server: parseServer('https://chat.test'),
    token: 't',
    fetch,
  });
  assert.equal((await client.me()).username, 'gladys');
  assert.equal(calls, 2);
});

test('socket: authenticates by challenge, refuses a wrong token', async () => {
  const server = createFakeServer();
  const events = [];
  const socket = await openSocket({
    url: 'wss://chat.test/api/v4/websocket',
    token: TOKEN,
    WebSocket: server.WebSocket,
    onEvent: (event) => events.push(event.event),
  });
  server.publish(server.users.keys().next().value, 'fami1yfami1yfami1yfami1yfa', 'hello');
  assert.deepEqual(events, ['posted']);
  socket.close();
  assert.equal(await socket.closed, 'closed by the integration');

  await assert.rejects(
    openSocket({
      url: 'wss://chat.test/api/v4/websocket',
      token: 'wrong',
      WebSocket: server.WebSocket,
      onEvent: () => {},
    }),
    { kind: ERROR_KINDS.TOKEN },
  );
});

test('parseImage: the "image/jpg;base64,..." of Gladys', () => {
  const image = parseImage('image/jpg;base64,/9j/4AAQ');
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.extension, 'jpg');
  assert.equal(image.buffer.length, 6);
  assert.equal(parseImage('not an image'), null);
  assert.equal(parseImage(null), null);
});

test('the widget fits the budget of the core in every state', () => {
  const recent = Array.from({ length: 8 }, (_, i) => ({
    channel: 'a-very-long-team-name/a-very-long-channel-name',
    sender: 'someone-with-a-long-name',
    text: 'x'.repeat(600),
    at: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString(),
  }));
  for (const connection of Object.values(CONNECTION)) {
    for (const language of ['en', 'fr', 'de', 'es']) {
      for (const list of [[], recent]) {
        const content = buildWidgetContent(
          {
            connection,
            username: connection === CONNECTION.CONNECTED ? 'gladys' : null,
            channels: { joined: 1, total: 2 },
            recent: list,
          },
          language,
        );
        assert.deepEqual(validateWidgetContent(content), [], `${connection} ${language}`);
        assert.ok(content.components.length <= 8);
      }
    }
  }
});
