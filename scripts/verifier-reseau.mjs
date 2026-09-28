/**
 * Le vérificateur de mise à jour contre un VRAI serveur HTTP, avec le VRAI code.
 *
 * Pourquoi hors de jest : le preset `jest-expo` installe un `fetch` de fortune
 * qui renvoie un objet sans `status` ni `text()` — le réseau y est simulé. Un
 * test « de bout en bout » qui passerait malgré cela ne prouverait rien. On
 * compile donc le cœur avec esbuild et on l'exécute dans Node, où `fetch` est
 * celui de Node et où l'on peut réellement écouter sur un port.
 *
 * Ce que ça valide, et que rien d'autre ne valide : que le manifeste est
 * récupéré, validé, comparé, et transformé en bruit — sur une vraie connexion,
 * avec les vrais codes HTTP.
 *
 * Usage : node scripts/verifier-reseau.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PUBLIEE = "0.9.0";
const VERSION_INSTALLEE = "0.1.0";
const EMPRINTE = "b".repeat(64);
const JOUR = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const verifications = [];
function verifie(nom, ok, detail = "") {
  verifications.push(Boolean(ok));
  const marque = ok ? "OK   " : "ECHEC";
  console.log(`  ${marque} ${nom}${detail ? `  [${detail}]` : ""}`);
}

// --- le vrai code, compile ----------------------------------------------------
//
// esbuild est resolu par chemin : il vit dans les dependances de `desktop/` et
// la racine du depot n'a pas de package.json. Le compiler ici, plutot que d'en
// dependre du depot, evite d'ajouter une dependance racine pour un script de
// verification.

const dossier = mkdtempSync(path.join(tmpdir(), "maj-reseau-"));
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

// --- le vrai manifeste, servi par un vrai serveur ------------------------------

function manifeste(overrides = {}) {
  return {
    version: VERSION_PUBLIEE,
    released_at: "2026-10-01T09:00:00Z",
    mandatory: false,
    notes: "Corrige la lecture sous Windows.",
    artifacts: {
      "linux-x64": { file: "a.AppImage", url: "https://exemple.test/a.AppImage", sha256: EMPRINTE, size: 368777716 },
      "win32-x64": { file: "a.exe", url: "https://exemple.test/a.exe", sha256: EMPRINTE, size: 398439782 },
      android: { file: "a.apk", url: "https://exemple.test/a.apk", sha256: EMPRINTE, size: 129467919 },
    },
    ...overrides,
  };
}

let requetes = 0;
const serveur = createServer((req, res) => {
  if (req.url === "/versions.json") {
    requetes += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(manifeste()));
    return;
  }
  if (req.url === "/obligatoire.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(manifeste({ mandatory: true })));
    return;
  }
  if (req.url === "/corrompu.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end('{"version": "ceci nest pas une version"}');
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const adresse = serveur.address();
const base = `http://127.0.0.1:${adresse.port}`;

/** Exactement ce que font les deux coques : `fetch` + `validerManifeste`. */
async function controler(url) {
  const reponse = await fetch(url, { cache: "no-store" });
  if (!reponse.ok) return { code: reponse.status, manifeste: null };
  return { code: 200, manifeste: coeur.validerManifeste(await reponse.json()) };
}

function bruit(manifeste, etat, plateforme = "win32-x64", enLecture = false) {
  return coeur.decider({
    versionCourante: VERSION_INSTALLEE,
    manifeste,
    plateforme,
    maintenant: T0,
    enLecture,
    etat,
  });
}

// --- 1. la requete part et la reponse est valide -------------------------------

console.log("1. Le manifeste est recupere en HTTP");
const { code, manifeste: publie } = await controler(`${base}/versions.json`);
verifie("le serveur a bien ete interroge", requetes === 1, `${requetes} requete(s)`);
verifie("la reponse est en 200", code === 200, `code ${code}`);
verifie("le manifeste passe la validation", publie !== null);
verifie("la version publiee est lue", publie?.versionTexte === VERSION_PUBLIEE, publie?.versionTexte);

// --- 2. la decision d'afficher -------------------------------------------------

console.log("2. La decision");
verifie("première visite : signalement", bruit(publie, coeur.ETAT_INITIAL).bruit === "information");

let etat = coeur.ETAT_INITIAL;
const echelle = [];
for (let i = 0; i < 4; i += 1) {
  echelle.push(bruit(publie, etat).bruit);
  etat = coeur.apresSignalement(etat, VERSION_PUBLIEE);
}
verifie(
  "l'echelle monte puis se tait",
  JSON.stringify(echelle) === JSON.stringify(["information", "proposition", "silencieux", "silencieux"]),
  echelle.join(" > "),
);
verifie("jamais pendant une lecture", bruit(publie, etat, "win32-x64", true).bruit === "silencieux");
verifie(
  "ignorer est definitif",
  bruit(publie, coeur.ignorerVersion(coeur.ETAT_INITIAL, VERSION_PUBLIEE)).bruit === "rien",
);
verifie(
  "plus tard respecte son delai",
  bruit(publie, coeur.reporterVersion(coeur.ETAT_INITIAL, VERSION_PUBLIEE, T0)).bruit === "silencieux" &&
    bruit(publie, coeur.reporterVersion(coeur.ETAT_INITIAL, VERSION_PUBLIEE, T0 - 8 * JOUR)).bruit === "information",
);

// --- 3. la plateforme servie ---------------------------------------------------

console.log("3. Les trois plateformes");
for (const plateforme of ["linux-x64", "win32-x64", "android"]) {
  const decision = bruit(publie, coeur.ETAT_INITIAL, plateforme);
  verifie(
    `${plateforme} : artefact + signalement`,
    decision.bruit === "information" && coeur.artefactPour(publie, plateforme) !== null,
  );
}

// --- 4. la mise a jour obligatoire --------------------------------------------

console.log("4. Mise a jour obligatoire");
const { manifeste: obligatoire } = await controler(`${base}/obligatoire.json`);
verifie(
  "elle court-circute le report",
  bruit(obligatoire, coeur.reporterVersion(coeur.ETAT_INITIAL, VERSION_PUBLIEE, T0)).bruit === "obligatoire",
);

// --- 5. les cas defavorables --------------------------------------------------

console.log("5. Ce qui doit echouer sans rien casser");
const { manifeste: corrompu } = await controler(`${base}/corrompu.json`);
verifie("un manifeste illisible est rejete", corrompu === null);
verifie("et ne declenche rien", bruit(corrompu, coeur.ETAT_INITIAL).bruit === "rien");

const absent = await controler(`${base}/absent.json`);
verifie("une URL qui repond 404 ne leve pas", absent.code === 404 && absent.manifeste === null);

const horsLigne = await controler("http://127.0.0.1:1/versions.json").catch((e) => ({ erreur: e }));
verifie("un serveur injoignable ne leve pas", Boolean(horsLigne.erreur) && horsLigne.manifeste === undefined);

// --- 6. le rythme, une fois pour toutes ---------------------------------------

console.log("6. Le rythme des controles");
let dernier = null;
let controles = 0;
for (let minute = 0; minute < 24 * 60; minute += 5) {
  const maintenant = T0 + minute * 60_000;
  if (coeur.planifierControle(dernier ?? coeur.ETAT_INITIAL, maintenant).doitController) {
    controles += 1;
    dernier = { ...coeur.ETAT_INITIAL, dernierControle: maintenant };
  }
}
verifie("une controle par jour sur 24 h, meme avec 288 lancements", controles === 1, `${controles} controle(s)`);

await new Promise((r) => serveur.close(r));

// --- verdict ------------------------------------------------------------------

const reussis = verifications.filter(Boolean).length;
console.log(`\n${reussis}/${verifications.length} verifications OK`);
process.exit(reussis === verifications.length ? 0 : 1);
