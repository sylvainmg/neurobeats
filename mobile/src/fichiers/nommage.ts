/**
 * Comment on nomme les fichiers transférés.
 *
 * Séparé de `dossiers.ts` volontairement : ce module ne touche à aucune API
 * native, donc il se teste sans appareil — et c'est la seule partie du transfert
 * qui décide d'une chaîne de caractères qui finit sur le disque du téléphone.
 */

/**
 * Un nom de fichier qui passe partout.
 *
 * Les titres viennent de YouTube — « Lil Uzi Vert - What You Saying - [Official
 * Music Video] ». Les crochets sont interdits dans une URI sans encodage, et
 * c'est bien le chemin construit à partir de ce nom que le module refuse :
 * `IllegalArgumentException: Illegal character in path`, sans autre explication.
 * Le transfert échouait donc sur tous les titres qui en contiennent, et rien ne
 * le disait.
 *
 * On retire ce que le système de fichiers refuse (`/`, `:`, `*`, …) et ce que
 * l'URI refuse (`[`, `]`, `#`, `%`, `?`), puis on borne la longueur : au-delà de
 * 90 caractères, le système tronque ou refuse. Les apostrophes et les virgules
 * restent — elles sont normales dans un titre et n'ont jamais gêné personne.
 */
export function nommerFichier(base: string, extension: string, secours: string): string {
  const propre = base
    .replace(/[/\\:*?"<>|[\]#%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const court = (propre || secours).slice(0, 90).trim();
  return `${court}.${extension}`;
}
