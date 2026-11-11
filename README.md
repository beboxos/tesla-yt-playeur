# Tesla YT Player

Une interface web pour regarder/écouter YouTube depuis le navigateur embarqué d'une
Tesla (ou tout navigateur restreint qui bloque la lecture vidéo mais autorise
l'audio. et l'affichage d'images).

## Pourquoi ?

Le navigateur de la Tesla bloque la lecture vidéo (HTML5 `<video>` / iframes
YouTube), mais autorise la lecture audio. Ce projet contourne la limitation en :

- résolvant côté serveur, via [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), les
  flux audio/vidéo directs d'une vidéo YouTube (sans jamais charger de page
  YouTube dans un navigateur — ce qui évite les murs anti-bot type "confirmez
  que vous n'êtes pas un robot"),
- décodant le flux vidéo avec `ffmpeg` et en extrayant des captures d'écran
  régulières (JPEG), affichées côté client en boucle comme un **diaporama**
  "vidéo" basse fréquence,
- jouant l'audio via une balise `<audio>` standard, dont le flux est proxifié
  par le serveur (avec support du `Range` HTTP pour permettre le seek).

Le résultat : sur l'écran de la voiture, on a une recherche YouTube complète,
le son de la vidéo, et une image qui se rafraîchit plusieurs fois par seconde
pour donner une idée de ce qui se passe à l'écran.

## Fonctionnalités

- Recherche YouTube sans clé API (scraping de la page de résultats, avec
  cache serveur de 5 minutes et retry automatique en cas de réponse
  incomplète de YouTube)
- Tri par date (plus récent en premier)
- Page d'accueil type "abonnements" : affiche la dernière vidéo de chaque
  chaîne favorite au chargement
- Chaînes favorites : raccourcis de recherche, ajout en un clic via l'étoile
  sur les vignettes de résultats, liste de suggestions personnalisable
  (`PRESET_CHANNELS` dans `index.html`), bouton pour afficher/masquer la barre
  de favoris
- Vignettes carrées avec titre/chaîne/durée en surimpression
- Sélection automatique de la piste audio française quand une vidéo propose
  plusieurs doublages
- Lecteur avec barre de progression / seek, pause, stop, bouton plein écran
  (ajusté sur la largeur)
- Réglages du diaporama : FPS (0.5 à 10), qualité JPEG (10 à 80), et
  décalage image/son au démarrage (-10s à +10s) — réglables dans le lecteur
  et mémorisés comme valeurs par défaut dans l'onglet Réglages
- Réglages d'affichage (largeur des vignettes, échelle globale de
  l'interface via `zoom` CSS) pour compenser les navigateurs embarqués qui
  rapportent un `devicePixelRatio` ou un viewport inhabituel
- Panneau d'infos techniques (résolution, DPI, user-agent...) dans les
  réglages, utile pour diagnostiquer ce genre de problème d'affichage
- Split-screen optionnel (bouton "Split") : partage l'écran 50/50 entre la
  vidéo et une carte de navigation ([TeslaNav](https://teslanav.com/)) dans
  un `<iframe>`. **Nécessite que le site soit servi en HTTPS** : un iframe
  n'est considéré comme un contexte sécurisé par le navigateur que si toute
  la chaîne de pages parentes l'est aussi, sans quoi certaines API web (ex.
  `crypto.randomUUID`) échouent à l'intérieur de l'iframe
- Indicateur de chargement pendant la résolution du flux (quelques secondes,
  le temps que `yt-dlp` trouve une URL jouable) au lieu d'une image cassée
- Interface sombre, pensée pour un écran tactile en voiture

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌───────────────────────────┐
│  Navigateur  │◄────►│  nginx (web)      │◄────►│  ytcap (Node/Express)     │
│  (Tesla)     │      │  sert index.html  │      │  - yt-dlp : résout les    │
└─────────────┘      │  proxy /yt/ ─────►│      │    flux YouTube directs   │
                      └──────────────────┘      │  - ffmpeg : décode la      │
                                                  │    vidéo → JPEG           │
                                                  │  - proxy audio (Range)    │
                                                  └───────────────────────────┘
```

- **`web`** (nginx:alpine) : sert l'interface statique (`index.html`) et
  reverse-proxy `/yt/*` vers le service `ytcap`.
- **`ytcap`** : serveur Express qui, pour une vidéo donnée :
  1. utilise `yt-dlp` (avec le runtime JS `deno`, requis pour résoudre les
     challenges de signature de YouTube) pour obtenir des URLs de flux
     directes — en testant plusieurs clients d'extraction et en validant
     chaque URL, car YouTube n'autorise pas toujours l'accès direct selon le
     client utilisé ;
  2. lance `ffmpeg` pour décoder le flux vidéo et en extraire des images
     JPEG à intervalle régulier (`/yt/frame.jpg`) ;
  3. proxifie le flux audio vers le client (`/yt/audio`, avec support du
     `Range` HTTP pour le seek) ;
  4. fait aussi office de proxy de recherche YouTube (scraping HTML, sans
     clé API).

## Démarrage rapide

Prérequis : Docker + Docker Compose.

```bash
git clone <url-du-repo>
cd tesla-yt-playeur
docker compose up -d --build
```

L'interface est ensuite disponible sur `http://<host>:18081`.

## Configuration

- Le port exposé est défini dans [`docker-compose.yml`](docker-compose.yml)
  (`18081:80` par défaut).
- La fréquence de capture côté serveur est définie par `CAPTURE_FPS`
  dans [`ytcap/server.js`](ytcap/server.js) (10 FPS par défaut).
- Les chaînes favorites sont stockées côté client (`localStorage`), pas de
  configuration serveur nécessaire.

## Avertissement

Ce projet scrape les pages publiques de résultats YouTube et résout des flux
vidéo/audio directs via `yt-dlp` : il est destiné à un usage personnel.
Respectez les conditions d'utilisation de YouTube. Le fonctionnement dépend
de mécanismes internes de YouTube qui évoluent régulièrement (anti-bot,
formats disponibles) : `yt-dlp` doit être maintenu à jour pour rester
fonctionnel.

## Licence

[MIT](LICENSE)

## Bonus : Mahjong Impérial — Légendes d'Asie

`mahjong.html` est un jeu de Mahjong Solitaire autonome (une seule page HTML5,
JavaScript Vanilla, Web Audio API, Canvas 2D), servi par nginx sur
`/mahjong.html`.

- 5 niveaux (Le Sanctuaire, Les Tours Jumelles, La Pyramide du Dragon,
  La Tortue Impériale, Le Palais Céleste) générés par retrait inversé de paires :
  chaque donne a au moins une solution
- Règle officielle : une tuile est libre si rien ne la recouvre (même
  partiellement) sur la couche supérieure et si son flanc gauche ou droit est libre
- Tuiles 3D en CSS, faces vectorielles SVG (36 classes : Caractères, Bambous,
  Cercles, Vents, Dragons, Fleurs, Saisons)
- Indice / Mélanger (en garantissant une solution) / Annuler, combo temporel,
  bonus de temps, étoiles
- Effets de fusion (éclairs, particules), sons synthétisés et musique générative
- Profil, avatars, progression et tableau des scores (avec maîtres IA)
  sauvegardés dans `localStorage`
