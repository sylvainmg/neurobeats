// Constantes partagees main + preload (sans import electron : le preload sandboxe
// ne peut pas charger un module qui touche a `app`).
//
// PORT DÉDIÉ À L'APP : 8041 est le port du backend QUE L'APP SPAWN (conteneur
// isolé). 8040 reste le port du backend de dev (web/.env.local, dev.sh) — les
// deux coexistent sans collision, chacun avec son propre daemon mpv (socket
// scoupé par port cote backend).
export const BACKEND_PORT = 8041;
export const FRONTEND_PORT = 3150;
export const BACKEND_API_BASE = `http://127.0.0.1:${BACKEND_PORT}`;

/**
 * Manifeste des versions publiées (voir `shared/update/README.md`).
 *
 * C'est LE SEUL endroit à toucher pour pointer la vérification de mise à jour
 * vers un autre hébergement. Il est écrasable sans reconstruire l'application :
 * `NEUROBEATS_UPDATE_MANIFEST` (tests, intégration) ou `update-manifest.json`
 * dans le dossier de données utilisateur, que l'utilisateur peut donc corriger
 * lui-même si l'hébergement change.
 *
 * Doit être en HTTPS : ce fichier décide du binaire qui sera ensuite lancé.
 *
 * Pourquoi `releases/latest/download/` et non une version en dur : cette
 * constante est figée dans le binaire au moment de la compilation. Si elle
 * contenait `v0.1.0`, publier 0.2.0 n'marcherait que pour les applications
 * construites après 0.2.0 — c'est-à-dire jamais, puisque le contrôle sert
 * justement à mettre à jour celles qui précèdent. `latest` est un alias que
 * GitHub recalcule : l'URL reste la même pour toutes les versions futures, et
 * c'est ce qui rend cette constante valable à vie.
 *
 * Pourquoi les GitHub Releases et non des fichiers dans une branche : le
 * `.exe` fait 389 Mo et l'AppImage 352 Mo, et GitHub refuse au-delà de 100 Mo
 * dans un dépôt. Les Releases acceptent 2 Go par asset. Seul le manifeste, qui
 * pèse 900 octets, pourrait vivre dans une branche.
 */
export const URL_MANIFSTE_MAJ =
  "https://github.com/sylvainmg/neurobeats-releases/releases/latest/download/versions.json";