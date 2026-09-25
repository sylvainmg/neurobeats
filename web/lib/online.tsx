"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * État de la connexion internet, suivi en temps réel.
 *
 * `navigator.onLine` est le seul signal fiable disponible côté renderer : il
 * bascule sur les transitions réelles (câble débranché, Wi-Fi perdu, mode avion)
 * et Chromium — donc Electron — le met à jour sans qu'on ait à sonder quoi que
 * ce soit. Les événements `online`/`offline` couvrent le temps réel, et la
 * réécoute au focus rattrape un état obsoli si l'OS a changé d'avis sans émettre
 * d'événement (cas du retour de veille).
 *
 * Ce n'est PAS une garantie de connectivité utile : un réseau local actif sans
 * sortie Internet reste « en ligne » pour le navigateur. Cela dit dans les deux
 * sens — l'UI n'active jamais une action réseau sur la foi de ce seul signal, et
 * le backend reste l'arbitre (il répond 502/504 si YouTube ou le LLM ne
 * répondent pas).
 */
interface OnlineValue {
  /** false dès que le navigateur signale une coupure. */
  online: boolean;
}

const OnlineContext = createContext<OnlineValue>({ online: true });

/**
 * Lecture initiale, faite pendant le premier rendu.
 *
 * `navigator.onLine` est déjà disponible au montage : le lire ici évite l'effet
 * en cascade d'un `setPending(false)` déclenché par l	useEffect (que le linter
 * signale à juste titre, et qui afficherait « hors ligne » une frame trop
 * tard). Le rendu serveur n'a pas de `navigator` : on suppose alors en ligne et
 * on laisse l'hydratation trancher.
 */
function lireEnLigne(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export function OnlineProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(lireEnLigne);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    // Retour de veille / changement d'onglet : on relit plutôt que de croire un
    // état figé depuis le moment où l'onglet a été masqué. Chromium n'émet pas
    // toujours `offline` quand l'OS perd le réseau pendant la veille.
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return <OnlineContext.Provider value={{ online }}>{children}</OnlineContext.Provider>;
}

/** Connexion internet connue, en temps réel. */
export function useOnline(): OnlineValue {
  return useContext(OnlineContext);
}
