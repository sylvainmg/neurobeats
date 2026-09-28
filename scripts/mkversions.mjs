/**
 * Fabrique le manifeste `versions.json` à partir des artefacts réellement
 * construits.
 *
 * Usage :
 *   node scripts/mkversions.mjs <version> --sortie <fichier> [options]
 *
 * Options :
 *   --base <url>            racine de publication, OBLIGATOIRE (ex.
 *                            https://github.com/<moi>/<depot>/releases/download/v0.1.0/)
 *   --note <texte>          notes de version publiées dans le manifeste
 *   --obligatoire           marque la mise à jour comme nécessaire
 *   --artefact <clé>=<fichier>   répété, clé parmi :
 *                            linux-x64 linux-arm64 win32-x64 darwin-x64
 *                            darwin-arm64 android
 *
 * L'empreinte de chaque fichier est calculée ici, au moment de la publication,
 * et non recopiée depuis un fichier de build : c'est le seul endroit où l'on est
 * certain de hacher exactement ce qui est mis en ligne. Une erreur de rapport ici
 * se paie cher — le client refuse d'installer, ce qui est le comportement
 * voulu, mais vaudrait mieux l'éviter.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

const CLES = new Set([
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "android",
]);

function erreur(message) {
  console.error(`mkversions : ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const version = args[0];
if (!version || version.startsWith("--")) {
  erreur("version attendue en premier argument, ex. `node scripts/mkversions.mjs 0.1.0 …`");
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  erreur(`version illisible : « ${version} » (attendu X.Y.Z ou X.Y.Z-pre)`);
}

let sortie = "versions.json";
// Aucun defaut, deliberement. Avec un defaut, l'oubli de `--base` produirait un
// manifeste parfaitement valide et des URL pointant ailleurs : rien ne le
// signalerait, et l'application irait interroger un domaine qui n'existe pas en
// ratant silencieusement sa verification. Les URL de publication sont une
// decision, elles se passent explicitement.
let base = null;
let note = "";
let obligatoire = false;
const artefacts = new Map();

for (let i = 1; i < args.length; i += 1) {
  const arg = args[i];
  const suivant = () => args[++i];
  if (arg === "--sortie") sortie = suivant();
  else if (arg === "--base") base = suivant();
  else if (arg === "--note") note = suivant();
  else if (arg === "--obligatoire") obligatoire = true;
  else if (arg === "--artefact") {
    const valeur = suivant();
    if (!valeur) erreur("--artefact attend <clé>=<fichier>");
    const egal = valeur.indexOf("=");
    if (egal < 0) erreur(`--artefact mal formé : « ${valeur} »`);
    const cle = valeur.slice(0, egal);
    const fichier = valeur.slice(egal + 1);
    if (!CLES.has(cle)) {
      erreur(`clé inconnue « ${cle} ». Attendues : ${[...CLES].join(", ")}`);
    }
    if (!existsSync(fichier)) erreur(`fichier absent : ${fichier}`);
    artefacts.set(cle, fichier);
  } else erreur(`option inconnue : ${arg}`);
}

if (artefacts.size === 0) {
  erreur("aucun artefact : le manifeste serait vide. Passe au moins un --artefact.");
}

if (base === null) {
  erreur(
    "--base est obligatoire. Exemple :\n" +
      "  --base https://github.com/sylvainmg/neurobeats-releases/releases/download/v0.1.0/",
  );
}

if (!base.startsWith("https://")) {
  erreur(
    `--base doit être en HTTPS : « ${base} ».\n` +
      "  Un APK est du code exécutable et le .exe lance un binaire : le client " +
      "refuse déjà les URL non-HTTPS, autant le dire ici.",
  );
}

if (!base.endsWith("/")) base += "/";

function sha256(fichier) {
  return new Promise((resoudre, rejeter) => {
    const hash = createHash("sha256");
    const flux = createReadStream(fichier);
    flux.on("error", rejeter);
    flux.on("data", (morceau) => hash.update(morceau));
    flux.on("end", () => resoudre(hash.digest("hex")));
  });
}

const table = {};
for (const [cle, fichier] of artefacts) {
  const nom = path.basename(fichier);
  table[cle] = {
    file: nom,
    // `new URL` encodera les espaces si le client résout une URL relative ; on
    // publie donc un nom lisible, pas un nom pré-encodé.
    url: base + nom,
    sha256: await sha256(fichier),
    size: statSync(fichier).size,
  };
  console.log(`  ✓ ${cle.padEnd(13)} ${nom} (${(statSync(fichier).size / 1024 ** 2).toFixed(1)} Mo)`);
}

const manifeste = {
  version,
  released_at: new Date().toISOString(),
  mandatory: obligatoire,
  notes: note,
  artifacts: table,
};

const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(path.dirname(path.resolve(sortie)), { recursive: true });
writeFileSync(sortie, `${JSON.stringify(manifeste, null, 2)}\n`, "utf8");
console.log(`\nManifeste écrit : ${sortie} (version ${version}, ${artefacts.size} artefact(s))`);
