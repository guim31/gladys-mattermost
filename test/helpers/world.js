// -----------------------------------------------------------------------------
// The integration wired to the fake Gladys of the SDK and to a fake Mattermost
// server: a `fetch` replacement for the REST API and a WebSocket replacement,
// shaped like the answers of a real Mattermost 10 (test/fixtures/mattermost/).
// No network, a virtual clock, manual sleeps.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/mattermost/${name}.json`, import.meta.url), 'utf8'));

export const SERVER = 'https://chat.test';
export const TOKEN = 'bot-token-0123456789abcdefghij';
const me = fixture('users-me');
export const BOT_ID = me.id;
export const ALICE_ID = 'a1icea1icea1icea1icea1icea';
export const MALLORY_ID = 'ma11orma11orma11orma11orma';
export const TEAM = 'home';
export const GARAGE = 'garagegaragegaragegaragega'; // home/garage, public
export const FAMILY = 'fami1yfami1yfami1yfami1yfa'; // home/family, private, the bot is in it
export const START = Date.parse('2026-10-20T10:00:00Z');

export const BASE_CONFIG = {
  server_url: SERVER,
  access_token: TOKEN,
  channels: 'home/garage',
  allowed_users: 'alice',
  language: 'en',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const error = (status, id, message) =>
  json(status, { id, message, detailed_error: '', request_id: 'r', status_code: status });

const dmId = (a, b) => [a, b].sort().join('__').slice(0, 26);

/** A fake Mattermost server: just enough of the REST API and of the WebSocket, recorded. */
export function createFakeServer() {
  const server = {
    down: null, // an error code (ECONNREFUSED...) makes every request fail
    tokens: new Set([TOKEN]),
    users: new Map([
      [BOT_ID, { ...me }],
      [ALICE_ID, { id: ALICE_ID, username: 'alice', delete_at: 0 }],
      [MALLORY_ID, { id: MALLORY_ID, username: 'mallory', delete_at: 0 }],
    ]),
    channels: new Map([
      [GARAGE, { id: GARAGE, name: 'garage', type: 'O', team: TEAM }],
      [FAMILY, { id: FAMILY, name: 'family', type: 'P', team: TEAM }],
    ]),
    members: new Map([
      [GARAGE, new Set([ALICE_ID, MALLORY_ID])],
      [FAMILY, new Set([BOT_ID, ALICE_ID, MALLORY_ID])],
    ]),
    posts: [], // every post, { id, channel_id, user_id, message, create_at, type, file_ids }
    uploads: [],
    requests: [], // { method, path }
    sockets: [],
    muted: false, // the sockets stop answering pings
    rejectPosts: false, // a 400, as for a message too long
    clock: () => START,
  };

  const userOf = (token) => (server.tokens.has(token) ? BOT_ID : null);

  server.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(pathname.replace(/^\/api\/v4/, ''));
    server.requests.push({ method, path });
    if (init.signal?.aborted) {
      throw init.signal.reason; // like fetch: an aborted request never starts
    }
    if (server.down) {
      throw new TypeError('fetch failed', { cause: { code: server.down } });
    }
    if (!pathname.startsWith('/api/v4/')) {
      return new Response('<html>Not found</html>', { status: 404 });
    }
    const caller = userOf((init.headers?.authorization ?? '').replace(/^Bearer /, ''));
    if (!caller) {
      return json(401, fixture('error-401'));
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;

    if (path === '/users/me') {
      return json(200, server.users.get(BOT_ID));
    }
    if (method === 'POST' && path === '/users/usernames') {
      return json(
        200,
        [...server.users.values()].filter((user) => body.includes(user.username)),
      );
    }
    let match = path.match(/^\/teams\/name\/([^/]+)\/channels\/name\/([^/]+)$/);
    if (match) {
      const channel = [...server.channels.values()].find(
        (c) => c.team === match[1] && c.name === match[2],
      );
      if (!channel || (channel.type === 'P' && !server.members.get(channel.id)?.has(BOT_ID))) {
        return error(404, 'app.channel.get_by_name.missing.app_error', 'Channel does not exist.');
      }
      return json(200, channel);
    }
    match = path.match(/^\/channels\/([^/]+)\/members\/([^/]+)$/);
    if (match) {
      if (server.members.get(match[1])?.has(match[2])) {
        return json(200, { channel_id: match[1], user_id: match[2] });
      }
      // A real Mattermost answers 403 to a bot asking about a channel it is not in.
      return error(
        403,
        'api.context.permissions.app_error',
        'You do not have the appropriate permissions.',
      );
    }
    match = path.match(/^\/channels\/([^/]+)\/members$/);
    if (method === 'POST' && match) {
      const channel = server.channels.get(match[1]);
      if (!channel || channel.type !== 'O') {
        return error(403, 'api.context.permissions.app_error', 'You do not have permission.');
      }
      server.members.get(channel.id).add(body.user_id);
      return json(201, { channel_id: channel.id, user_id: body.user_id });
    }
    if (method === 'POST' && path === '/channels/direct') {
      const id = dmId(body[0], body[1]);
      server.channels.set(id, { id, name: body.join('__'), type: 'D', team: '' });
      server.members.set(id, new Set(body));
      return json(201, { id, type: 'D' });
    }
    match = path.match(/^\/channels\/([^/]+)\/posts$/);
    if (match) {
      const since = Number(searchParams.get('since'));
      const posts = server.posts.filter(
        (post) => post.channel_id === match[1] && post.create_at >= since,
      );
      return json(200, {
        order: posts.map((post) => post.id).reverse(),
        posts: Object.fromEntries(posts.map((post) => [post.id, post])),
      });
    }
    match = path.match(/^\/channels\/([^/]+)$/);
    if (match) {
      const channel = server.channels.get(match[1]);
      return channel
        ? json(200, channel)
        : error(404, 'app.channel.get.existing.app_error', 'Unable to find the channel.');
    }
    if (method === 'POST' && path === '/posts') {
      if (!server.members.get(body.channel_id)?.has(BOT_ID)) {
        return error(403, 'api.context.permissions.app_error', 'You do not have permission.');
      }
      if (server.rejectPosts) {
        return error(400, 'model.post.is_valid.msg.app_error', 'Invalid message.');
      }
      const post = server.publish(BOT_ID, body.channel_id, body.message, {
        file_ids: body.file_ids ?? [],
      });
      return json(201, post);
    }
    if (method === 'POST' && path === '/files') {
      const file = init.body.get('files');
      server.uploads.push({
        channel: init.body.get('channel_id'),
        size: file.size,
        type: file.type,
      });
      return json(201, { file_infos: [{ id: `file${server.uploads.length}` }] });
    }
    return error(404, 'api.context.404.app_error', 'Sorry, we could not find the page.');
  };

  /** A new post, pushed to the sockets as a `posted` event (as Mattermost does). */
  server.publish = (userId, channelId, message, extra = {}) => {
    const post = {
      id: `post${String(server.posts.length + 1).padStart(22, '0')}`,
      create_at: server.clock(),
      update_at: server.clock(),
      delete_at: 0,
      user_id: userId,
      channel_id: channelId,
      root_id: '',
      message,
      type: '',
      props: {},
      ...extra,
    };
    server.posts.push(post);
    const channel = server.channels.get(channelId);
    const event = {
      ...fixture('ws-posted'),
      data: {
        ...fixture('ws-posted').data,
        channel_type: channel?.type ?? 'O',
        post: JSON.stringify(post),
        sender_name: `@${server.users.get(userId)?.username}`,
      },
      broadcast: { channel_id: channelId },
    };
    if (server.members.get(channelId)?.has(BOT_ID)) {
      server.sockets.filter((socket) => socket.open).forEach((socket) => socket.push(event));
    }
    return post;
  };

  /** Closes every open socket, as a server restart would (code 1006). */
  server.dropSockets = () => {
    server.sockets.filter((socket) => socket.open).forEach((socket) => socket.drop(1006));
  };

  server.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.open = false;
      this.listeners = {};
      this.sent = [];
      server.sockets.push(this);
      setImmediate(() => {
        if (server.down) {
          this.emit('error', {});
          this.emit('close', { code: 1006 });
          return;
        }
        this.emit('open', {});
      });
    }

    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }

    emit(type, event) {
      (this.listeners[type] ?? []).forEach((listener) => listener(event));
    }

    push(data) {
      this.emit('message', { data: JSON.stringify(data) });
    }

    send(text) {
      const message = JSON.parse(text);
      this.sent.push(message);
      if (message.action === 'authentication_challenge') {
        if (!server.tokens.has(message.data?.token)) {
          this.drop(1006); // a real Mattermost closes the socket without a reply
          return;
        }
        this.open = true;
        this.push({ status: 'OK', seq_reply: message.seq });
        this.push(fixture('ws-hello'));
      } else if (message.action === 'ping' && !server.muted) {
        this.push({ status: 'OK', seq_reply: message.seq, data: { text: 'pong' } });
      }
    }

    drop(code) {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.open = false;
      this.emit('close', { code });
    }

    close() {
      this.drop(1000);
    }
  };

  return server;
}

export function createMemoryStore(initial = {}) {
  return {
    data: structuredClone(initial),
    writes: 0,
    async load() {
      return structuredClone(this.data);
    },
    async save(data) {
      this.data = structuredClone(data);
      this.writes += 1;
    },
    async flush() {},
  };
}

/** Lets pending promises, fetches and socket events settle. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function createWorld({
  config = BASE_CONFIG,
  stored = {},
  server = createFakeServer(),
  linkedUser,
  pingIntervalMs,
} = {}) {
  const gladys = createFakeGladys({ config, linkedUser });
  const store = createMemoryStore(stored);
  const clock = { time: START };
  server.clock = () => clock.time;
  const sleeps = [];
  const app = registerHandlers(gladys, {
    fetch: server.fetch,
    WebSocket: server.WebSocket,
    store,
    now: () => clock.time,
    pingIntervalMs,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const entry = { ms, resolve };
        sleeps.push(entry);
        signal.addEventListener('abort', resolve);
      }),
  });
  /** Ends the oldest pending sleep, moving the clock forward by its length. */
  const wake = async () => {
    await settle();
    const entry = sleeps.shift();
    if (!entry) {
      throw new Error('nothing is sleeping');
    }
    clock.time += entry.ms;
    entry.resolve();
    await settle();
    return entry.ms;
  };
  await gladys.connect();
  await settle();
  return { gladys, fake: gladys.fake, server, store, clock, sleeps, wake, app };
}
