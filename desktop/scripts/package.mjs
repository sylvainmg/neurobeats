/**
 * Empaquetage pour une CIBLE donnée, en distinguant cible et machine.
 *
 * Usage :
 *   node scripts/package.mjs                     # cible = machine hote
 *   node scripts/package.mjs win32-x64           # installeur Windows, depuis Linux/macOS
 *   node scripts/package.mjs win32-x64 --dir     # sans installeur (dossier seul)
 *
 * Pourquoi ce script existe : les cibles se construisaient avec
 * `electron-builder --win` lance a la main sur la machine de developpement, et
 * tous les scripts de preparation lisaient `process.platform`. Un build etranger
 * embeddait donc les binaires de la machine — c'est ainsi qu'un `.exe` de
 * 321 Mo a ete produit avec des ELF Linux a l'interieur, donc SANS LECTEUR
 * AUDIO, sans que rien ne le signale. Ici la cible est un ARGUMENT, propagé aux
 * scripts de fetch et de staging, et la charge utile est verifiee avant
 * l'assemblage.
 *
 * Ce que le script ne peut pas faire : construire macOS hors macOS. Ni
 * electron-builder ni wine ne peuvent produire un `.dmg` ; l'erreur est levee
 * tot dans build-env.mjs.
 */
import { spawn } from "node:child_process";
import { readdirSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");

const cibleDemandee = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
const seulementDossier = process.argv.includes("--dir");

// La cible doit etre dans l'environnement AVANT le chargement de build-env :
// ses exports (`isWindows`, `platformKey`…) sont evalues a l'import, et un
// import statique passerait donc avant cette affectation — le script
// s'annoncerait sur la plate-forme de la machine alors qu'il construit pour
// une autre. D'ou l'import dynamique.
if (cibleDemandee) process.env.NEUROBEATS_TARGET_PLATFORM = cibleDemandee;

const { platformKey, estCroisee, formatAttendu, lanceurCible, say } = await import(
  "./lib/build-env.mjs"
);

const env = { ...process.env };

// electron-builder utilise lui aussi wine pour assembler le NSIS. Sans le meme
// prefixe que le runtime Python, il initialiserait le sien dans `~/.wine` :
// deux prefixes a creer, et un build qui dependrait de l'etat de celui qu'il
// rencontre en premier.
const lanceur = lanceurCible();
if (lanceur.prefixe.length > 0) {
  Object.assign(env, lanceur.env);
}

const cible = platformKey();
say(`→ Cible : ${cible} (format attendu : ${formatAttendu()})`);
if (estCroisee()) {
  say(
    "→ Build croisé depuis " +
      `${process.platform} : la charge utile sera celle de ${cible}, ` +
      "jamais celle de la machine.",
  );
}

function etape(commande, args) {
  return new Promise((resoudre, rejeter) => {
    say(`\n── ${commande} ${args.join(" ")}`);
    const child = spawn(commande, args, {
      cwd: desktop,
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
    child.on("error", rejeter);
    child.on("close", (code) => {
      if (code === 0) resoudre();
      else rejeter(new Error(`${commande} a échoué (code ${code})`));
    });
  });
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

/**
 * Espace disque disponible sur la partition qui porte `release/`.
 *
 * L'empaquetage AppImage ne compresse pas sur place : electron-builder copie
 * l'arbre entier dans `release/__appImage-x64` avant de construire l'image.
 * Sur un artefact de 350 Mo, cela double l'occupation — et l'echec arrive en
 * pleine copie, apres tout le staging, avec un `ENOSPC` qui ne dit pas quoi
 * nettoyer. Deuxieme occurrence en une journee, sur 2,3 Go libres.
 *
 * L'echec etant tardif et incomprehensible, on refuse de commencer plutot que de
 * decouvrir la panne au bout de plusieurs minutes de staging.
 */
function goLibres(chemin) {
  try {
    const s = statfsSync(chemin);
    return (s.bsize * s.bfree) / 1073741824;
  } catch {
    return null;
  }
}

const ESPACE_REQUIS_GO = 8;

/**
 * Le bundle doit etre plus recent que la plus recente des sources.
 *
 * `package:linux` et `package:win` ontemplace le script `package`, qui faisait
 * `npm run build` en tete. L'etape a disparu au passage, sans que rien ne le
 * signale : `dist/` etant reutilise tel quel, modifier une source puis
 * emballer produisait un artefact contenant l'AnciEN code — installable,
 * fonctionnel, et silencieusement faux. Concretement, un changement de l'URL du
 * manifeste de mise a jour a ete publie sans effet, parce que le bundle datait
 * de la veille.
 *
 * Ce controle rend l'oubli impossible a repeter : meme si l'etape de build
 * revenait a disparaitre, l'echec serait explicite et immediat.
 */
function sourcesModifieesApres(bundle) {
  let pire = 0;
  const parcourir = (dossier) => {
    for (const entree of readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(chemin);
      else if (/\.(ts|tsx)$/.test(entree.name)) {
        pire = Math.max(pire, statSync(chemin).mtimeMs);
      }
    }
  };
  parcourir(path.join(desktop, "src"));
  return pire > statSync(bundle).mtimeMs;
}

try {
  // Avant tout : le disque. L'echec d'espace est le plus cher a diagnostiquer
  // de tous ceux d'ici, parce qu'il survient apres le staging complet, dans une
  // copie interne d'electron-builder, et ne nomme aucun fichier a nettoyer.
  const libres = goLibres(desktop);
  if (libres !== null && libres < ESPACE_REQUIS_GO) {
    throw new Error(
      `espace disque insuffisant : ${libres.toFixed(1)} Go libres, ` +
        `${ESPACE_REQUIS_GO} Go requis. L'AppImage duplique l'arbre de ` +
        "release/ avant de compresser. Libère d'abord `release/`, `bin/`, " +
        "`runtime/` et `.runtime/`, qui sont regenerables.",
    );
  }
  if (libres !== null) {
    say(`→ Espace disque : ${libres.toFixed(1)} Go libres`);
  }

  await etape(npm, ["run", "build"]);

  const bundle = path.join(desktop, "dist", "main", "index.js");
  if (sourcesModifieesApres(bundle)) {
    throw new Error(
      "le bundle dans dist/ est plus ancien qu'une source : le code packagé " +
        "ne serait pas celui de l'arbre de travail. Lance `npm run build`.",
    );
  }
  say("✓ bundle à jour des sources");

  await etape("node", ["scripts/sync-web.mjs"]);
  await etape("node", ["scripts/fetch-llama.mjs"]);
  await etape("node", ["scripts/fetch-bin.mjs"]);
  await etape("node", ["scripts/stage-runtime.mjs"]);
  if (seulementDossier) {
    await etape(npx, ["electron-builder", "--dir", "--x64", "--publish", "never"]);
  } else if (cible.startsWith("win32")) {
    await etape(npx, ["electron-builder", "--win", "nsis", "--x64", "--publish", "never"]);
  } else {
    await etape(npx, ["electron-builder", "--linux", "AppImage", "deb", "--x64", "--publish", "never"]);
  }
  say(`\n✓ ${cible} empaqueté`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
