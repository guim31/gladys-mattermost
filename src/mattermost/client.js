// -----------------------------------------------------------------------------
// A small client of the Mattermost REST API v4 (/api/v4), the handful of
// endpoints a bot needs: who am I, users by username, channels, membership,
// direct channels, posts, recent posts of a channel and file upload. Built on
// fetch, injected by the tests.
//
// Every failure is a MattermostError with a `kind` (below), so the callers and
// the texts never parse a server message. The token never appears in an error
// message nor in a log line.
// -----------------------------------------------------------------------------

export const ERROR_KINDS = {
  NOT_CONFIGURED: 'not_configured',
  INVALID_URL: 'invalid_url',
  NO_TOKEN: 'no_token',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  NOT_MATTERMOST: 'not_mattermost',
  TOKEN: 'token',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
};

// Failures that say nothing about the configuration: the network or the server
// will come back, the connection loop retries.
export const TRANSIENT_KINDS = new Set([
  ERROR_KINDS.UNREACHABLE,
  ERROR_KINDS.TIMEOUT,
  ERROR_KINDS.RATE_LIMITED,
  ERROR_KINDS.SERVER,
]);

export class MattermostError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, without secret
   * @param {object} [details]
   * @param {number} [details.status] HTTP status
   * @param {string} [details.id] Mattermost error id (api.context.session_expired.app_error...)
   * @param {number} [details.retryAfterMs] wait asked by a 429
   */
  constructor(kind, message, { status, id, retryAfterMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MattermostError';
    this.kind = kind;
    this.status = status;
    this.id = id;
    this.retryAfterMs = retryAfterMs;
  }
}

const API_PATH = '/api/v4';
export const REQUEST_TIMEOUT_MS = 15_000;
// The longest wait a 429 is honored with inside one call; beyond, the caller decides.
const MAX_INLINE_RETRY_MS = 10_000;
// The default MaxPostSize of a Mattermost server (characters).
export const MAX_POST_LENGTH = 16_383;

function kindOf(status) {
  switch (status) {
    case 401:
      return ERROR_KINDS.TOKEN;
    case 403:
      return ERROR_KINDS.FORBIDDEN;
    case 404:
      return ERROR_KINDS.NOT_FOUND;
    case 429:
      return ERROR_KINDS.RATE_LIMITED;
    default:
      // Any other 4xx (a message too long, a malformed request): refused as is.
      return status >= 500 ? ERROR_KINDS.SERVER : ERROR_KINDS.REJECTED;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** The wait a 429 asks for: Retry-After (seconds), else X-Ratelimit-Reset (seconds). */
function retryAfter(headers) {
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const seconds = Number(headers?.get?.(name));
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return undefined;
}

export class MattermostClient {
  /**
   * @param {object} options
   * @param {URL} options.server base address of the server
   * @param {string} options.token personal access token or bot token
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ server, token, fetch: fetchImpl = globalThis.fetch }) {
    this.base = server;
    this.token = token;
    this.fetch = fetchImpl;
  }

  url(path, query) {
    const url = new URL(this.base.href.replace(/\/$/, '') + API_PATH + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  /** The WebSocket address of the server: ws:// or wss://, same host and path. */
  websocketUrl() {
    const url = this.url('/websocket');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  /**
   * One request. Resolves with the JSON body of a 2xx answer.
   * @param {string} method
   * @param {string} path below /api/v4
   * @param {object} [options]
   */
  async request(method, path, { body, query, timeoutMs = REQUEST_TIMEOUT_MS, signal, form } = {}) {
    if (!this.token) {
      throw new MattermostError(ERROR_KINDS.NO_TOKEN, 'No access token');
    }
    const headers = { authorization: `Bearer ${this.token}` };
    let payload = form;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(this.url(path, query), {
          method,
          headers,
          body: payload,
          // A fresh timeout per attempt: the wait of a 429 does not eat the next one.
          signal: signal
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) {
          throw err; // stopped by the caller: not a failure of the server
        }
        if (err?.name === 'TimeoutError') {
          throw new MattermostError(ERROR_KINDS.TIMEOUT, `No answer within ${timeoutMs} ms`);
        }
        throw new MattermostError(
          ERROR_KINDS.UNREACHABLE,
          `Server unreachable: ${err?.cause?.code ?? err?.message}`,
        );
      }
      let data;
      const text = await response.text().catch(() => '');
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = null;
      }
      if (response.ok) {
        if (data === null) {
          throw new MattermostError(
            ERROR_KINDS.NOT_MATTERMOST,
            `Not a Mattermost answer (HTTP ${response.status})`,
          );
        }
        return data;
      }
      if (data === null && [404, 405].includes(response.status)) {
        // A web server that is not Mattermost: the address is wrong.
        throw new MattermostError(
          ERROR_KINDS.NOT_MATTERMOST,
          `No Mattermost API at this address (HTTP ${response.status})`,
          { status: response.status },
        );
      }
      const kind = kindOf(response.status);
      const retryAfterMs = retryAfter(response.headers);
      if (kind === ERROR_KINDS.RATE_LIMITED && attempt === 0) {
        const wait = retryAfterMs ?? 1000;
        if (wait <= MAX_INLINE_RETRY_MS) {
          await sleep(wait, signal);
          if (signal?.aborted) {
            throw signal.reason;
          }
          continue;
        }
      }
      // The server message never carries the token.
      const id = typeof data?.id === 'string' ? data.id : undefined;
      const reason = typeof data?.message === 'string' ? data.message.slice(0, 200) : '';
      throw new MattermostError(
        kind,
        `${method} ${path.split('?')[0]}: HTTP ${response.status} ${reason}`.trim(),
        { status: response.status, id, retryAfterMs },
      );
    }
  }

  /** The account behind the token: `{ id, username, is_bot... }`. */
  me(options) {
    return this.request('GET', '/users/me', options);
  }

  /** The users with these usernames (unknown ones are missing from the answer). */
  async usersByUsernames(usernames, { signal } = {}) {
    if (usernames.length === 0) {
      return [];
    }
    const data = await this.request('POST', '/users/usernames', { body: usernames, signal });
    return Array.isArray(data) ? data : [];
  }

  /** A channel by its id. */
  channel(channelId, { signal } = {}) {
    return this.request('GET', `/channels/${encodeURIComponent(channelId)}`, { signal });
  }

  /** A channel by the name of its team and its own name, as in its address. */
  channelByName(team, name, { signal } = {}) {
    return this.request(
      'GET',
      `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(name)}`,
      { signal },
    );
  }

  /** True when the user is a member of the channel. */
  async isMember(channelId, userId, { signal } = {}) {
    try {
      await this.request(
        'GET',
        `/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        { signal },
      );
      return true;
    } catch (err) {
      if (err instanceof MattermostError && err.kind === ERROR_KINDS.NOT_FOUND) {
        return false;
      }
      throw err;
    }
  }

  /** Adds a user to a channel (the bot joins a public channel of its team). */
  addMember(channelId, userId, { signal } = {}) {
    return this.request('POST', `/channels/${encodeURIComponent(channelId)}/members`, {
      body: { user_id: userId },
      signal,
    });
  }

  /** The direct channel of two users, created the first time. Resolves with its id. */
  async directChannel(userId, otherId, { signal } = {}) {
    const data = await this.request('POST', '/channels/direct', {
      body: [userId, otherId],
      signal,
    });
    return data.id;
  }

  /** Writes a post. Resolves with the created post. */
  createPost({ channelId, message, fileIds }, { signal } = {}) {
    return this.request('POST', '/posts', {
      body: {
        channel_id: channelId,
        message,
        ...(fileIds?.length ? { file_ids: fileIds } : {}),
      },
      signal,
    });
  }

  /**
   * The posts of a channel created or changed since `since` (milliseconds),
   * oldest first.
   */
  async postsSince(channelId, since, { signal } = {}) {
    const data = await this.request('GET', `/channels/${encodeURIComponent(channelId)}/posts`, {
      query: { since },
      signal,
    });
    const posts = Object.values(data?.posts ?? {});
    return posts.sort((a, b) => a.create_at - b.create_at);
  }

  /** Uploads a file to a channel. Resolves with its file id. */
  async uploadFile(channelId, buffer, contentType, fileName) {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([buffer], { type: contentType }), fileName);
    const data = await this.request('POST', '/files', { form, timeoutMs: 30_000 });
    const id = data?.file_infos?.[0]?.id;
    if (typeof id !== 'string') {
      throw new MattermostError(ERROR_KINDS.NOT_MATTERMOST, 'Upload answer without a file id');
    }
    return id;
  }
}
