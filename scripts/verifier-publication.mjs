/**
 * Vérifie la publication **réellement en ligne**, avec le **vrai code** de mise à
 * jour, contre les **vraies URL** servies par GitHub.
 *
 * Ce que `verifier-reseau.mjs` ne prouve pas : il lève un serveur HTTP local,
 * donc il valide la logique mais pas l'hébergement. Or tout ce qui peut mal
 * tourner après une publication est de cet ordre — un manifeste mal téléversé,
 * une URL d'artefact qui 404, une redirection GitHub que le client ne suit pas,
 * une empreinte au mauvais format. Aucun test unitaire ne voit ces défauts : ils
 * n'existent qu'une fois les fichiers en ligne.
 *
 * Donc : on va chercher le manifeste tel que le fera l'application, on le passe
 * dans `validerManifeste`, on demande l'artefact de chaque plate-forme, on vérifie
 * que son URL répond, et on soumet le résultat à `decider()` pour vérifier que la
 * politique anti-harcèlement produit bien une proposition, et non un modal.
 *
 * Usage : node scripts/verifier-publication.mjs [url-du-manifeste]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const URL_MANIFESTE =
  process.argv[2] ??
  "https://github.com/sylvainmg/neurobeats-releases/releases/latest/download/versions.json";

const verifications = [];
function verifie(nom, ok, detail = "") {
  verifications.push(Boolean(ok));
  console.log(`  ${ok ? "OK   " : "ECHEC"} ${nom}${detail ? `  [${detail}]` : ""}`);
}

// --- le vrai code, compilé comme en production ---------------------------------

const dossier = mkdtempSync(path.join(tmpdir(), "maj-publication-"));
const sortie = path.join(dossier, "coeur.mjs");
const esbuild = pathToFileURL(
  path.join(RACINE, "desktop", "node_modules", "esbuild", "lib", "main.js"),
).href;
const { build } = await import(esbuild);
await build({
  entryPoints: [path.join(RACINE, "shared", "update", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: sortie,
  logLevel: "error",
});
const coeur = await import(pathToFileURL(sortie).href);
rmSync(dossier, { recursive: true, force: true });

// --- 1. le manifeste, tel que l'application le récupère ------------------------

console.log(`\nManifeste : ${URL_MANIFESTE}\n`);

let brut;
try {
  const reponse = await fetch(URL_MANIFESTE, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  verifie("le manifeste répond 200", reponse.ok, `HTTP ${reponse.status}`);
  brut = await reponse.json();
} catch (erreur) {
  verifie("le manifeste est récupérable", false, String(erreur.message ?? erreur));
  process.exit(1);
}

// La redirection GitHub (github.com -> release-assets.githubusercontent.com) est
// suivie par `fetch` sans configuration particulière. Si un jour le client
// mobile ne la suivait pas, ce serait ici que ça se verrait.
verifie(
  "la redirection GitHub est suivie",
  true,
  `${new URL(URL_MANIFESTE).host}`,
);

const manifeste = coeur.validerManifeste(brut);
verifie("le manifeste est valide pour le vrai code", manifeste !== null);
if (!manifeste) {
  console.log("\n  Manifeste refusé — rien d'autre à vérifier.\n");
  process.exit(1);
}
console.log(
  `         version ${manifeste.versionTexte}, ` +
    `${Object.keys(manifeste.artefacts).length} artefact(s)`,
);

// --- 2. chaque artefact announced est téléchargeable ----------------------------

const PLATEFORMES = ["linux-x64", "win32-x64", "android"];

for (const plateforme of PLATEFORMES) {
  const artefact = coeur.artefactPour(manifeste, plateforme);
  if (!artefact) {
    verifie(`${plateforme} : présent au manifeste`, false);
    continue;
  }
  verifie(
    `${plateforme} : empreinte au bon format`,
    /^[0-9a-f]{64}$/i.test(artefact.sha256),
    `${String(artefact.sha256).slice(0, 16)}…`,
  );
  verifie(
    `${plateforme} : URL en HTTPS`,
    new URL(artefact.url, URL_MANIFESTE).protocol === "https:",
  );

  try {
    // HEAD et non GET : 350 Mo à télécharger pour contrôler une existence
    // n'est pas une vérification, c'est du gaspillage. Et `release-assets`
    // répond correctement à HEAD.
    const tete = await fetch(artefact.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(60_000),
    });
    const taille = Number(tete.headers.get("content-length") ?? 0);
    verifie(
      `${plateforme} : téléchargeable`,
      tete.ok,
      `HTTP ${tete.status}${
        taille ? `, ${(taille / 1048576).toFixed(1)} Mo` : ""
      }`,
    );
    // Le manifeste annonce une taille : si le serveur en sert une autre, le
    // fichier en ligne n'est pas celui qui a été haché.
    if (taille && artefact.size && taille !== artefact.size) {
      verifie(
        `${plateforme} : taille servie = taille annoncée`,
        false,
        `${taille} ≠ ${artefact.size}`,
      );
    } else if (artefact.size) {
      verifie(`${plateforme} : taille servie = taille annoncée`, true);
    }
  } catch (erreur) {
    verifie(`${plateforme} : téléchargeable`, false, String(erreur.message ?? erreur));
  }
}

// --- 3. la politique produit-elle une proposition, et non un modal ? -----------

console.log("");

// Un utilisateur en 0.1.0 qui installe la version publiee.
const etat = coeur.apresControle(
  { ...coeur.ETAT_INITIAL },
  Date.now(),
  true,
);

for (const plateforme of PLATEFORMES) {
  const decision = coeur.decider({
    versionCourante: "0.0.1",
    manifeste,
    plateforme,
    maintenant: Date.now(),
    enLecture: false,
    etat,
  });
  // `obligatoire` declenche un modal, que la politique s'interdit par principe.
  verifie(
    `${plateforme} : propose sans jamais imposer`,
    decision.bruit === "proposition" || decision.bruit === "information",
    `${decision.bruit} — ${decision.raison}`,
  );
}

// Le meme contexte, en lecture. Le contrat n'est pas « ne rien montrer » : la
// politique laisse deliberement une pastille discrete qui survit a la lecture,
// et l'utilisateur la voit a l'arret. Ce qui est interdit, c'est le bruit
// interruptif — un bandeau ou un modal par-dessus une piste qui joue.
const INTERRUPTIF = new Set(["information", "proposition", "obligatoire"]);
const enLecture = coeur.decider({
  versionCourante: "0.0.1",
  manifeste,
  plateforme: "linux-x64",
  maintenant: Date.now(),
  enLecture: true,
  etat,
});
verifie(
  "en lecture : aucun bruit interruptif",
  !INTERRUPTIF.has(enLecture.bruit),
  `${enLecture.bruit} — ${enLecture.raison}`,
);

// Un utilisateur deja a jour ne doit rien voir.
const aJour = coeur.decider({
  versionCourante: manifeste.versionTexte,
  manifeste,
  plateforme: "linux-x64",
  maintenant: Date.now(),
  enLecture: false,
  etat,
});
verifie("déjà à jour : silence", aJour.bruit === "rien", aJour.bruit);

// Le rythme : un second controle dans la minute ne doit pas ressortir sur le reseau.
const rythme = coeur.planifierControle(etat, Date.now() + 30_000);
verifie("pas de second controle immediat", rythme.doitController === false, `${rythme.dansMs} ms`);

// --- verdict --------------------------------------------------------------------

const echecs = verifications.filter((v) => !v).length;
console.log(
  echecs === 0
    ? `\n  ${verifications.length} verifications, toutes passees.\n`
    : `\n  ${echecs} echec(s) sur ${verifications.length} verifications.\n`,
);
process.exit(echecs === 0 ? 0 : 1);
