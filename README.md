# Tesla YT Player

Une interface web pour regarder/écouter YouTube depuis le navigateur embarqué d'une
Tesla (ou tout navigateur restreint qui bloque la lecture vidéo mais autorise
l'audio et l'affichage d'images).

## Pourquoi ?

Le navigateur de la Tesla bloque la lecture vidéo (HTML5 `<video>` / iframes
YouTube), mais autorise la lecture audio. Ce projet contourne la limitation en :

- jouant l'audio de la vidéo YouTube via un `<iframe>` caché et l'API
  YouTube IFrame (`postMessage`),
- affichant en parallèle un **diaporama** de la vidéo : un navigateur headless
  (Playwright/Chromium) côté serveur lit réellement la vidéo et envoie des
  captures d'écran régulières (JPEG) au client, qui les affiche en boucle
  comme un flux "vidéo" basse fréquence.

Le résultat : sur l'écran de la voiture, on a une recherche YouTube complète,
le son de la vidéo, et une image qui se rafraîchit plusieurs fois par seconde
pour donner une idée de ce qui se passe à l'écran.

## Fonctionnalités

- Recherche YouTube sans clé API (scraping de la page de résultats)
- Tri par date (plus récent en premier)
- Chaînes favorites : raccourcis de recherche, ajout en un clic via l'étoile
  sur les vignettes de résultats
- Lecteur avec barre de progression / seek, pause, stop
- Réglage du FPS du diaporama (0.5 à 10 FPS)
- Interface sombre, pensée pour un écran tactile en voiture

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────────────┐
│  Navigateur  │◄────►│  nginx (web)      │◄────►│  ytcap (Node/Express  │
│  (Tesla)     │      │  sert index.html  │      │  + Playwright/Chromium│
└─────────────┘      │  proxy /yt/ ─────►│      │  capture la vidéo     │
                      └──────────────────┘      │  YouTube en headless  │
                                                  └──────────────────────┘
```

- **`web`** (nginx:alpine) : sert l'interface statique (`index.html`) et
  reverse-proxy `/yt/*` vers le service `ytcap`.
- **`ytcap`** : serveur Express qui pilote un Chromium headless (Playwright)
  pour charger une vidéo YouTube embarquée, en extraire des captures d'écran
  régulières, contrôler la lecture (play/pause/seek) et faire la recherche
  YouTube côté serveur.

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
- La fréquence de capture côté serveur est définie par `CAPTURE_INTERVAL_MS`
  dans [`ytcap/server.js`](ytcap/server.js) (100 ms par défaut, soit 10 FPS
  max).
- Les chaînes favorites sont stockées côté client (`localStorage`), pas de
  configuration serveur nécessaire.

## Avertissement

Ce projet scrape les pages publiques de résultats YouTube et pilote un
navigateur headless pour afficher des vidéos embarquées : il est destiné à un
usage personnel. Respectez les conditions d'utilisation de YouTube.

## Licence

[MIT](LICENSE)
