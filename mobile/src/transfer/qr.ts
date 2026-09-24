/**
 * Décodage du code affiché par le bureau.
 *
 * Le bureau émet une adresse complète (`http://<ip>:<port>/t/<session>?k=<jeton>`).
 * On n'invente aucun format : ce que le bureau donne est ce qu'on suit, sinon un
 * futur changement de protocole casserait l'application sans prévenir.
 */
export type Code = {
  base: string;
  session: string;
  token: string;
};

export type ResultatCode = { ok: true; code: Code } | { ok: false; erreur: string };

export function lireCode(brut: string): ResultatCode {
  const nettoye = (brut ?? "").trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!nettoye) {
    return { ok: false, erreur: "Aucun code : vise l'écran de ton ordinateur." };
  }
  let url: URL;
  try {
    url = new URL(nettoye);
  } catch {
    return {
      ok: false,
      erreur: "Ce code n'est pas une adresse valide. Recopie celui affiché sur l'ordinateur.",
    };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, erreur: "Seules les adresses http du réseau local sont acceptées." };
  }
  const morceaux = url.pathname.split("/").filter(Boolean);
  if (morceaux[0] !== "t" || !morceaux[1]) {
    return { ok: false, erreur: "Cette adresse ne vient pas d'un transfert NeuroBeats." };
  }
  const token = url.searchParams.get("k") ?? "";
  if (!token) {
    return {
      ok: false,
      erreur: "Ce code est incomplet (jeton d'accès manquant). Affiche-en un nouveau.",
    };
  }
  return {
    ok: true,
    code: {
      base: `${url.protocol}//${url.host}`,
      session: morceaux[1],
      token,
    },
  };
}

export function adresseSession(code: Code): string {
  return `${code.base}/t/${code.session}?k=${encodeURIComponent(code.token)}`;
}

export function adresseAudio(code: Code, video_id: string): string {
  return `${code.base}/t/${code.session}/a/${video_id}?k=${encodeURIComponent(code.token)}`;
}

export function adressePochette(code: Code, video_id: string): string {
  return `${code.base}/t/${code.session}/c/${video_id}?k=${encodeURIComponent(code.token)}`;
}
