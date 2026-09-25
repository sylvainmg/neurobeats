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