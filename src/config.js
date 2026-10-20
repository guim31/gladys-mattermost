// -----------------------------------------------------------------------------
// Integration configuration (the `config_schema` of the manifest), normalized
// so the rest of the code never deals with `undefined`, stray spaces or a
// half-typed address.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  server_url: '',
  access_token: '',
  allowed_users: '',
  channels: '',
  command_prefix: '!',
  language: 'fr',
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Mattermost ids (users, channels, posts): 26 characters, lower case letters and digits.
const ID = /^[a-z0-9]{26}$/;
// Usernames: lower case letters, digits, ".", "-" and "_" (3 to 22 characters).
const USERNAME = /^[a-z0-9._-]{1,64}$/;
// A team and a channel as in the address of a channel: <team>/channels/<channel>.
const CHANNEL_PATH = /(?:^|\/)([a-z0-9_-]+)\/(?:channels\/)?([a-z0-9_-]+)$/i;

export const isId = (value) => ID.test(value);

/** Splits a list typed in a text field: commas, semicolons, spaces or new lines. */
export function parseList(value) {
  const items = trimmed(value)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(items)];
}

/** "@Alice" → "alice"; null when it cannot be a username. */
export function parseUsername(value) {
  const name = trimmed(value).replace(/^@/, '').toLowerCase();
  return USERNAME.test(name) ? name : null;
}

/**
 * A channel as the person typed it: a channel id, "team/channel", or the
 * address of the channel in the browser (https://chat.example.org/team/channels/channel).
 * @returns {{ id: string } | { team: string, name: string } | null}
 */
export function parseChannel(value) {
  const text = trimmed(value)
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  if (isId(text)) {
    return { id: text };
  }
  const match = text.match(CHANNEL_PATH);
  if (!match || (/^[a-z]+:\/\//i.test(text) && !/\/channels\//.test(text))) {
    return null;
  }
  return { team: match[1].toLowerCase(), name: match[2].toLowerCase() };
}

/**
 * The server address as a URL, or null when it is empty or not understood.
 * A bare host name gets https://. A sub-path (https://example.org/chat) is kept.
 * @param {string} value
 * @returns {URL|null}
 */
export function parseServer(value) {
  const text = trimmed(value).replace(/\/+$/, '');
  if (text === '') {
    return null;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.search = '';
    url.hash = '';
    // Pasted from the browser: keep the server, not the page.
    url.pathname = url.pathname.replace(/\/api\/v4.*$/, '').replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} [raw] config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = raw ?? {};
  const prefix = trimmed(config.command_prefix);
  const usernames = parseList(config.allowed_users).map(parseUsername).filter(Boolean);
  return {
    server_url: trimmed(config.server_url),
    access_token: trimmed(config.access_token),
    allowed_users: [...new Set(usernames)],
    channels: parseList(config.channels),
    // One to three characters, no space: "!" by default ("/" is taken by Mattermost).
    command_prefix: prefix === '' || prefix.length > 3 ? DEFAULT_CONFIG.command_prefix : prefix,
    language: LANGUAGES.includes(config.language) ? config.language : DEFAULT_CONFIG.language,
  };
}
