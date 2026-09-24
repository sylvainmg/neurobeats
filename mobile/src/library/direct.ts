/**
 * Téléchargement direct depuis YouTube : extraction via yt-dlp sur le téléphone.
 *
 * Deux vocabulaires :
 *
 * - **pur** (`videoIdDepuisUrl`, `choisirFormatAudio`) : ne touche à aucune
 *   librairie native, donc testable sans appareil ;
 * - **natif** (`informer`) : passe par `ytdlp-react-native`, un module natif
 *   Android qui embarque le vrai binaire yt-dlp — runtime Python et extracteurs
 *   de sites compris. C'est lui qui extrait l'audio de la vidéo, avec la
 *   robustesse que du JavaScript pur n'aurait pas. Son import est différé pour
 *   que les tests purs ne dépendent pas du module natif.
 *
 * Le flux choisi est ensuite confié au gestionnaire de transfert existant : la
 * persistance, le Wi-Fi uniquement et la lecture finale sont ceux de toute la
 * bibliothèque.
 */
import type { VideoInfo } from "ytdlp-react-native";

export type FormatAudio = {
  format_id?: string;
  ext?: string;
  abr?: number;
  tbr?: number;
  acodec?: string;
  url?: string;
  /** Taille annoncée (octets), pour le récapitulatif du transfert. */
  taille?: number;
};

/** Identifiants de vidéo acceptés : autant qu'une URL YouTube en fournit. */
const VIDEO_ID_RE = /^[\w-]{11}$/;

/** Une URL YouTube qui parle une vidéo précise, et son identifiant. */
export function videoIdDepuisUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const chemin = u.pathname;
    if (chemin.startsWith("/shorts/")) return chemin.slice(8).split("/")[0] ?? null;
    if (chemin.startsWith("/embed/")) return chemin.slice(7).split("/")[0] ?? null;
    if (u.hostname === "youtu.be") return chemin.split("/")[1] ?? null;
    if (u.hostname === "www.youtube.com" || u.hostname === "youtube.com" || u.hostname === "m.youtube.com") {
      if (chemin.startsWith("/watch")) return u.searchParams.get("v");
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Le format audio le plus lisible : m4a (AAC) d'abord, opus/webm ensuite.
 *
 * On demande un flux à un seul morceau (pas de fusion vidéo+audio) : la fusion
 * exigerait ffmpeg, que le module n'embarque pas. Un audio seul s'écoule donc
 * tel quel dans le gestionnaire de transfert.
 */
export function choisirFormatAudio(formats: FormatAudio[]): FormatAudio | null {
  const audios = formats.filter((format) => format.acodec !== "none" && format.acodec && format.url);
  if (audios.length === 0) return null;
  const parQualite = (format: FormatAudio) => format.abr ?? format.tbr ?? 0;
  const m4a = audios.filter((format) => format.ext === "m4a");
  const famille = m4a.length > 0 ? m4a : audios.filter((format) => format.ext === "opus" || format.ext === "webm");
  const source = famille.length > 0 ? famille : audios;
  return source.reduce((meilleur, format) =>
    parQualite(format) > parQualite(meilleur) ? format : meilleur,
  );
}

/**
 * Demande à yt-dlp ce qu'il sait d'une vidéo.
 *
 * Équivalent de `yt-dlp --dump-json` : la réponse expose les formats, dont on
 * retient le meilleur audio. L'extraction prend quelques secondes — l'appelant
 * affiche un état de chargement.
 *
 * Raises:
 *     Error: Message en français selon le refus de YouTube (vérification
 *     « pas un robot », géo-blocage, contenu privé/réservé) ou un échec réseau.
 */
export async function informer(videoId: string): Promise<InfoDirect> {
  if (!VIDEO_ID_RE.test(videoId)) throw new Error("Identifiant de vidéo invalide.");
  const YtDlp = (await import("ytdlp-react-native")).default;

  let donnees: VideoInfo;
  try {
    donnees = await YtDlp.extractInfo(`https://www.youtube.com/watch?v=${videoId}`);
  } catch (erreur) {
    throw new Error(messageExtraction(erreur));
  }

  const titre = (donnees.title ?? "").trim();
  if (!titre) throw new Error("YouTube n'a pas répondu. Réessaie dans un instant.");

  const format = choisirFormatAudio(
    (donnees.formats ?? []).map((format) => ({
      format_id: format.id,
      ext: format.ext,
      abr: format.abr,
      tbr: format.tbr,
      acodec: format.acodec,
      url: format.url,
      taille: format.filesize ?? format.filesizeApprox,
    })),
  );
  if (!format?.url) throw new Error("Aucun format audio extrait pour cette vidéo.");

  return {
    videoId,
    titre,
    chaine: (donnees.channel ?? donnees.uploader ?? "").trim(),
    duree: Math.round(donnees.duration ?? 0) || 0,
    format,
    pochette: donnees.thumbnail ?? null,
  };
}

/**
 * Un refus d'extraction devient un message qui dit pourquoi, pas un log natif.
 *
 * Les codes viennent du module ; quand ils se taisent, on retombe sur « Sign in
 * to confirm you're not a bot » — la phrase exacte que YouTube renvoie à
 * yt-dlp — pour la transformer en français.
 */
function messageExtraction(erreur: unknown): string {
  const code = (erreur as { code?: string } | null)?.code;
  const brut = erreur instanceof Error ? erreur.message : "";
  const table: Record<string, string> = {
    AUTHENTICATION_REQUIRED:
      "YouTube demande une vérification « pas un robot » pour cette vidéo. Réessaie plus tard.",
    GEO_RESTRICTED: "Cette vidéo est bloquée dans ta région.",
    PRIVATE_CONTENT: "Cette vidéo est privée : impossible d'en extraire l'audio.",
    AGE_RESTRICTED: "Cette vidéo est réservée aux adultes : impossible d'en extraire l'audio.",
    NETWORK_ERROR: "Le réseau n'a pas répondu pendant l'extraction. Réessaie.",
    INVALID_URL: "Lien de la vidéo incompréhensible.",
  };
  if (/sign in to confirm/i.test(brut)) return table.AUTHENTICATION_REQUIRED;
  if (code && table[code as string]) return table[code as string];
  return brut || "Extraction impossible. Réessaie dans un instant.";
}

export type InfoDirect = {
  videoId: string;
  titre: string;
  chaine: string;
  duree: number;
  format: FormatAudio;
  pochette: string | null;
};