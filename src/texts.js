// -----------------------------------------------------------------------------
// Texts the integration writes outside the widget (src/widgets.js): the
// connection status, the "Test the connection" report, the errors, and what
// the bot answers in Mattermost. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './mattermost/client.js';

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** Applies `render` to each language of a table of functions. */
export const each = (table, render) =>
  Object.fromEntries(Object.entries(table).map(([lang, value]) => [lang, render(value, lang)]));

// One short explanation per error kind (src/mattermost/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.NOT_CONFIGURED]: {
    en: 'enter the address of the Mattermost server and the token of the bot in the configuration',
    fr: "saisissez l'adresse du serveur Mattermost et le jeton du robot dans la configuration",
    de: 'gib die Adresse des Mattermost-Servers und das Token des Bots in der Konfiguration ein',
    es: 'introduzca la dirección del servidor Mattermost y el token del bot en la configuración',
  },
  [ERROR_KINDS.INVALID_URL]: {
    en: 'server address not understood, e.g. https://chat.example.org',
    fr: 'adresse du serveur incomprise, ex. https://chat.example.org',
    de: 'Serveradresse nicht verstanden, z. B. https://chat.example.org',
    es: 'dirección del servidor no válida, p. ej. https://chat.example.org',
  },
  [ERROR_KINDS.NO_TOKEN]: {
    en: 'enter the access token of the bot account',
    fr: "saisissez le jeton d'accès du compte du robot",
    de: 'gib das Zugriffstoken des Bot-Kontos ein',
    es: 'introduzca el token de acceso de la cuenta del bot',
  },
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the Mattermost server does not answer',
    fr: 'le serveur Mattermost ne répond pas',
    de: 'der Mattermost-Server antwortet nicht',
    es: 'el servidor Mattermost no responde',
  },
  [ERROR_KINDS.TIMEOUT]: {
    en: 'the Mattermost server answers too slowly',
    fr: 'le serveur Mattermost répond trop lentement',
    de: 'der Mattermost-Server antwortet zu langsam',
    es: 'el servidor Mattermost responde demasiado lento',
  },
  [ERROR_KINDS.NOT_MATTERMOST]: {
    en: 'no Mattermost server at this address: check it',
    fr: 'pas de serveur Mattermost à cette adresse : vérifiez-la',
    de: 'kein Mattermost-Server unter dieser Adresse: prüfe sie',
    es: 'no hay servidor Mattermost en esta dirección: revísela',
  },
  [ERROR_KINDS.TOKEN]: {
    en: 'access token refused (wrong, expired or revoked): enter a new one',
    fr: "jeton d'accès refusé (erroné, expiré ou révoqué) : saisissez-en un nouveau",
    de: 'Zugriffstoken abgelehnt (falsch, abgelaufen oder widerrufen): Gib ein neues ein',
    es: 'token de acceso rechazado (erróneo, caducado o revocado): introduzca uno nuevo',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'refused by the server: is the bot a member of the team and of the channel?',
    fr: "refusé par le serveur : le robot est-il membre de l'équipe et du canal ?",
    de: 'vom Server abgelehnt: Ist der Bot Mitglied des Teams und des Kanals?',
    es: 'rechazado por el servidor: ¿es el bot miembro del equipo y del canal?',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'channel, team or user not found on the server',
    fr: 'canal, équipe ou utilisateur introuvable sur le serveur',
    de: 'Kanal, Team oder Benutzer auf dem Server nicht gefunden',
    es: 'canal, equipo o usuario no encontrado en el servidor',
  },
  [ERROR_KINDS.REJECTED]: {
    en: 'request refused by the server (message too long?)',
    fr: 'requête refusée par le serveur (message trop long ?)',
    de: 'Anfrage vom Server abgelehnt (Nachricht zu lang?)',
    es: 'solicitud rechazada por el servidor (¿mensaje demasiado largo?)',
  },
  [ERROR_KINDS.RATE_LIMITED]: {
    en: 'too many requests: the server asks to slow down',
    fr: 'trop de requêtes : le serveur demande de ralentir',
    de: 'zu viele Anfragen: Der Server bittet um eine Pause',
    es: 'demasiadas solicitudes: el servidor pide ir más despacio',
  },
  [ERROR_KINDS.SERVER]: {
    en: 'the Mattermost server answered with an error',
    fr: 'le serveur Mattermost a répondu par une erreur',
    de: 'der Mattermost-Server hat mit einem Fehler geantwortet',
    es: 'el servidor Mattermost ha respondido con un error',
  },
};

/** The explanation of an error, in one language. */
export function errorText(err, language) {
  const text = ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER];
  return pick(text, language);
}

/** The explanation of an error, in the four languages. */
export const errorTexts = (err) =>
  each(ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER], (text) => text);

// The connection status of the Configuration screen when some watched channels
// or allowed people could not be found (the bot works with the others).
export const PARTIAL_STATUS = {
  en: (failed) => `Connected, but not found or not joined: ${failed}`,
  fr: (failed) => `Connecté, mais introuvables ou non rejoints : ${failed}`,
  de: (failed) => `Verbunden, aber nicht gefunden oder nicht beigetreten: ${failed}`,
  es: (failed) => `Conectado, pero no encontrados o sin acceso: ${failed}`,
};

// The report of the "Test the connection" action (and of the widget button).
export const REPORT_TEXT = {
  en: {
    connected: (user) => `Connected as @${user}.`,
    channels: (joined, total) => `Watched channels joined: ${joined}/${total}.`,
    noChannels: 'No watched channel yet.',
    users: (found, total) => `Allowed people found: ${found}/${total}.`,
    noUsers: 'No allowed person: the bot answers nobody.',
    failed: (error) => `Connection failed: ${error}.`,
  },
  fr: {
    connected: (user) => `Connecté en tant que @${user}.`,
    channels: (joined, total) => `Canaux surveillés rejoints : ${joined}/${total}.`,
    noChannels: 'Aucun canal surveillé pour l’instant.',
    users: (found, total) => `Personnes autorisées trouvées : ${found}/${total}.`,
    noUsers: 'Aucune personne autorisée : le robot ne répond à personne.',
    failed: (error) => `Échec de la connexion : ${error}.`,
  },
  de: {
    connected: (user) => `Verbunden als @${user}.`,
    channels: (joined, total) => `Beobachtete Kanäle beigetreten: ${joined}/${total}.`,
    noChannels: 'Noch kein beobachteter Kanal.',
    users: (found, total) => `Erlaubte Personen gefunden: ${found}/${total}.`,
    noUsers: 'Keine erlaubte Person: Der Bot antwortet niemandem.',
    failed: (error) => `Verbindung fehlgeschlagen: ${error}.`,
  },
  es: {
    connected: (user) => `Conectado como @${user}.`,
    channels: (joined, total) => `Canales vigilados a los que se ha unido: ${joined}/${total}.`,
    noChannels: 'Todavía no hay ningún canal vigilado.',
    users: (found, total) => `Personas autorizadas encontradas: ${found}/${total}.`,
    noUsers: 'Ninguna persona autorizada: el bot no responde a nadie.',
    failed: (error) => `Fallo de conexión: ${error}.`,
  },
};

// What the bot writes in Mattermost, in a direct message.
export const BOT_TEXT = {
  en: {
    linked: (name) =>
      `Hello ${name}! Your Mattermost account is now linked to Gladys: write to me here.`,
    notLinked:
      'Your Mattermost account is not linked to Gladys yet. In Gladys, open Integrations → Mattermost → Configuration, click "Generate a link code", then send me the code here.',
    unavailable: 'Gladys cannot read your message right now, please try again later.',
  },
  fr: {
    linked: (name) =>
      `Bonjour ${name} ! Votre compte Mattermost est lié à Gladys : écrivez-moi ici.`,
    notLinked:
      'Votre compte Mattermost n’est pas encore lié à Gladys. Dans Gladys, ouvrez Intégrations → Mattermost → Configuration, cliquez sur « Générer un code de liaison », puis envoyez-moi le code ici.',
    unavailable: 'Gladys ne peut pas lire votre message pour l’instant, réessayez plus tard.',
  },
  de: {
    linked: (name) =>
      `Hallo ${name}! Dein Mattermost-Konto ist jetzt mit Gladys verknüpft: Schreib mir hier.`,
    notLinked:
      'Dein Mattermost-Konto ist noch nicht mit Gladys verknüpft. Öffne in Gladys Integrationen → Mattermost → Konfiguration, klicke auf „Verknüpfungscode generieren“ und schick mir dann den Code hier.',
    unavailable: 'Gladys kann deine Nachricht gerade nicht lesen, versuch es später noch einmal.',
  },
  es: {
    linked: (name) =>
      `¡Hola ${name}! Su cuenta Mattermost está vinculada a Gladys: escríbame aquí.`,
    notLinked:
      'Su cuenta Mattermost aún no está vinculada a Gladys. En Gladys, abra Integraciones → Mattermost → Configuración, pulse «Generar un código de vinculación» y envíeme el código aquí.',
    unavailable: 'Gladys no puede leer su mensaje en este momento, inténtelo más tarde.',
  },
};
