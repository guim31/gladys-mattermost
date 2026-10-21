# Mattermost

Parlez à Gladys depuis [Mattermost](https://mattermost.com), la messagerie d'équipe libre que l'on peut
héberger soi-même, comme avec le bot Telegram de Gladys : posez une question, lancez une scène, recevez les
messages de Gladys en message direct. L'intégration écrit aussi dans des canaux Mattermost depuis vos
scènes, et lance des scènes quand un message ou une commande comme `!lumieres off` est écrit dans un canal
qu'elle surveille. Elle utilise un compte robot de votre serveur Mattermost, sur le réseau local ou sur
Internet.

> **Développée sans le matériel : vos retours sont les bienvenus.** L'intégration a été testée contre un
> vrai serveur Mattermost (Team Edition, en Docker), mais pas dans un vrai Gladys ni avec tous les clients
> Mattermost. Dites ce qui marche et ce qui ne marche pas dans les
> [issues](https://github.com/guim31/gladys-mattermost/issues) ou sur le
> [forum Gladys](https://community.gladysassistant.com).

## Prérequis

- Gladys Assistant **5.1.0** ou plus récent.
- Un serveur Mattermost joignable par Gladys (version 7 ou plus récente), et un compte administrateur pour
  créer le robot.
- Un **compte robot** (ou un utilisateur dédié avec un jeton d'accès personnel). N'utilisez pas votre
  compte personnel : le robot répond en son nom.
- Le nom d'utilisateur de chaque personne autorisée à parler au robot, par exemple `alice`.

## Configuration

1. Dans Mattermost, **Console système → Intégrations → Comptes de bot** : activez **Activer la création
   de comptes de bot**.
2. Menu principal **Intégrations → Comptes de bot → Ajouter un compte de bot** : un nom d'utilisateur comme
   `gladys`, le rôle **Membre**. Copiez le **jeton** affiché une seule fois à la fin.
3. Ajoutez le robot à votre équipe (menu de l'équipe **Ajouter des membres**, ou **Console système →
   Utilisateurs**).
4. Dans Gladys, **Intégrations → Mattermost → Configuration** :
   - **Adresse du serveur** : l'adresse de Mattermost comme dans le navigateur, par exemple
     `https://chat.example.org` ou `http://192.168.1.20:8065`.
   - **Jeton du robot** : le jeton de l'étape 2.
   - **Personnes autorisées** : les noms d'utilisateur que le robot écoute, séparés par des virgules
     (`alice, bob`). **Vide, le robot ne répond à personne** : il ignore les messages de tous ceux qui ne
     sont pas dans cette liste.
   - **Canaux surveillés** : les canaux dont les messages lancent des scènes, écrits `équipe/canal` comme
     dans leur adresse (`https://chat.example.org/maison/channels/garage` donne `maison/garage` ;
     l'adresse entière est acceptée aussi), ou par identifiant de canal, séparés par des virgules. Le robot
     rejoint seul les canaux publics ; ajoutez-le d'abord aux canaux privés.
   - **Préfixe des commandes** : `!` par défaut (`/` est pris par les commandes slash de Mattermost).
   - **Langue du robot** : la langue de ce que le robot écrit avant qu'une personne soit liée.
5. Cliquez sur **Tester la connexion** : le compte rendu donne le compte du robot, les canaux surveillés
   qu'il a rejoints et les personnes autorisées trouvées. L'état de connexion de la page le dit aussi, et
   nomme un canal ou une personne introuvable.

### Lier votre compte Mattermost pour parler à Gladys

Chaque utilisateur de Gladys qui veut parler à Gladys depuis Mattermost le fait une fois :

1. Dans Gladys, **Intégrations → Mattermost → Configuration**, bloc « Lier mon compte » : cliquez sur
   **Générer un code de liaison**.
2. Dans Mattermost, ouvrez un **message direct** avec le robot (le **+** à côté de « Messages directs »,
   puis son nom d'utilisateur) et envoyez-lui le code (8 caractères). Le robot confirme : votre compte
   Mattermost est lié à votre utilisateur Gladys. Vous pouvez le délier depuis le même bloc.

## Ce que fait le robot

- **En message direct** avec une personne autorisée : il transmet les messages à Gladys, avec les droits
  de l'utilisateur Gladys lié, exactement comme le bot Telegram : « Quelle est la température du salon ? »,
  « Éteins les lumières ». Les réponses de Gladys reviennent dans ce message direct, le Markdown rendu par
  Mattermost. Les messages que Gladys vous envoie (l'action de scène **Envoyer un message**, les messages
  système) y arrivent aussi, même avant toute conversation. Une image de caméra envoyée par une scène
  arrive en image.
- **Dans un canal surveillé** : chaque message d'une personne autorisée lance le déclencheur **Message
  Mattermost reçu**, et un message qui commence par le préfixe lance aussi **Commande Mattermost reçue**.
  Le robot n'y répond jamais de lui-même : la suite dépend de vos scènes.
- **Dans tout autre canal** (un message de groupe, un canal non surveillé) : il se tait. Gladys ne répond
  jamais là où d'autres peuvent lire.
- **Ce qu'il ignore** : toute personne non autorisée, ses propres messages (une scène qui écrit dans un
  canal surveillé ne se relance jamais elle-même), les messages système (« a rejoint le canal »), les
  modifications, et les messages de plus de 5 minutes quand il les lit (un « !ouvre garage » d'il y a deux
  heures ne s'exécute pas maintenant).
- **Après une coupure** (redémarrage du serveur, de Gladys, réseau perdu un instant) : il se reconnecte
  seul, et relit les messages des canaux surveillés et des messages directs écrits dans les 5 dernières
  minutes.

## Tableau de bord

Le widget **Mattermost** montre si le robot est connecté, son compte, les canaux surveillés qu'il a
rejoints, les 5 derniers messages reçus dans les canaux surveillés (auteur, texte, date) et un bouton
**Tester la connexion**. Les messages directs avec Gladys n'y figurent jamais : tous ceux qui voient le
tableau de bord voient le widget.

## Scènes

### Déclencheurs

- **Message Mattermost reçu** : une personne autorisée a écrit dans un canal surveillé. Filtres (vide =
  tous) : **Canal** (écrit comme dans la configuration, par exemple `maison/garage`) et **Expéditeur** (le
  nom d'utilisateur, sans `@` : `alice`). Variables : Message, Expéditeur, Canal, Identifiant du canal.
- **Commande Mattermost reçue** : une personne autorisée a écrit une commande dans un canal surveillé : le
  préfixe, puis un mot, puis d'éventuels arguments, par exemple `!lumieres off cuisine`. Filtre
  **Commande** : le mot **sans le préfixe, en minuscules** (`lumieres`) ; et Canal, Expéditeur. Variables :
  Commande (`lumieres`), Arguments (`off cuisine`), Message, Expéditeur, Canal, Identifiant du canal. Le
  même message lance aussi **Message Mattermost reçu**.
- **Connexion Mattermost perdue** : le robot ne joint plus le serveur, depuis une minute, ou son jeton est
  refusé. Variable : Erreur. Lancé une fois, jusqu'au retour de la connexion.
- **Connexion Mattermost rétablie** : le robot joint de nouveau le serveur après une perte de connexion.
  Variable : Compte du robot (nom d'utilisateur).

### Actions

- **Envoyer un message Mattermost** : écrit un message dans un canal (`équipe/canal`, son adresse ou son
  identifiant), ou à une personne en message direct (`@alice`). Le message accepte les variables de scène
  et le Markdown de Mattermost (`**gras**`, `_italique_`, listes, liens, `@here`). Le robot doit être dans
  le canal, ou pouvoir le rejoindre (un canal public de son équipe). Résultats : Envoyé (oui/non),
  Identifiant du message, Erreur. Un message raté n'arrête pas la scène : testez **Envoyé** par une
  condition si besoin.

Pour écrire à un utilisateur de Gladys, l'action **Envoyer un message** de Gladys marche aussi : elle
atteint son compte Mattermost lié.

### Idées de scènes

- **Garage par commande** : déclencheur **Commande Mattermost reçue**, commande `garage`, canal
  `maison/garage` ; puis une condition sur la variable Arguments égale à `ferme`, et l'action qui ferme le
  garage.
- **Fin de la machine à laver** : quand la puissance de la prise de la machine retombe, **Envoyer un
  message Mattermost** à `maison/famille` : « La machine à laver a fini @here ».
- **Alerte quand le robot est coupé** : déclencheur **Connexion Mattermost perdue**, puis une notification
  par un autre canal (Gotify, ntfy, SMS) avec la variable Erreur.

## Dépannage

- **« pas de serveur Mattermost à cette adresse »** : utilisez l'adresse avec laquelle vous ouvrez
  Mattermost dans le navigateur, sans `/login` ni l'équipe. `https://<adresse>/api/v4/system/ping` doit
  répondre `{"status":"OK"…}`.
- **« jeton d'accès refusé »** : le jeton a été révoqué, ou le compte du robot désactivé. Créez un nouveau
  jeton dans **Intégrations → Comptes de bot**.
- **Un canal surveillé n'est pas rejoint** : l'état de la page et le test le nomment. Vérifiez les noms de
  l'équipe et du canal dans l'adresse du canal, ajoutez le robot à l'équipe, et au canal s'il est privé,
  puis enregistrez de nouveau la configuration.
- **Le robot ne me répond pas** : votre nom d'utilisateur est-il dans **Personnes autorisées**, écrit
  exactement ? Lui écrivez-vous en message direct (pas dans un message de groupe) ? Votre compte est-il lié
  (le robot vous donne alors la marche à suivre) ?
- **Une commande ne lance pas la scène** : le filtre Commande est le mot sans le préfixe, en minuscules :
  `lumieres`, pas `!Lumieres`.
- **Derrière un proxy inverse**, le WebSocket (`/api/v4/websocket`) doit être transmis aussi, comme pour
  les applications Mattermost.
- Plus de détails dans les journaux de l'intégration avec `LOG_LEVEL=debug`.

## Limites

- Une personne liée à Gladys peut faire depuis Mattermost tout ce que peut faire son utilisateur Gladys :
  gardez une liste de personnes autorisées courte, et le jeton du robot secret.
- Un compte robot par Gladys. Le robot lit les messages par le WebSocket de Mattermost : une commande prend
  effet en une seconde environ. Les messages manqués pendant une coupure de plus de 5 minutes sont sautés.
- Les fichiers, images et messages vocaux envoyés au robot sont ignorés ; seul le texte compte. Les fils
  de discussion sont lus comme des messages ordinaires, et les réponses de Gladys ne vont pas dans le fil.
- Le robot est soumis aux limites de débit de l'API du serveur (10 requêtes par seconde et par compte par
  défaut) : gardez des messages de scènes raisonnables.
- Sans lien avec Mattermost, Inc. Mattermost est une marque de Mattermost, Inc.
