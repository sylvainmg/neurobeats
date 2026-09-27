/**
 * Build standalone de l'interface web/ → desktop/.runtime/web-standalone.
 *
 * Remplace sync-web.sh : le `rsync -a --exclude` (ligne 31) et le patch
 * python (ligne 37) ne fonctionnaient pas sous Windows.
 *
 * web/ est un perimetre READ-ONLY pour l'agent : on ne le modifie JAMAIS. Le
 * build se fait dans une copie de travail (.runtime/web-src), ou l'on ajoute
 * `output: "standalone"` (option qui ne s'active pas par variable d'env), puis
 * le resultat (server.js + node_modules minimal + .next) est copie dans
 * .runtime/web-standalone, servi par Electron via ELECTRON_RUN_AS_NODE=1.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyTree, isWindows, run, say } from "./lib/build-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const desktop = path.join(root, "desktop");
const src = path.join(desktop, ".runtime", "web-src");
const dist = path.join(desktop, ".runtime", "web-standalone");

// L'URL du backend est INLINEE dans le bundle client au build. Port dedie de
// l'app : 8041 (distinct du backend de dev sur 8040). On le force ici pour une
// reproductibilite totale.
const apiUrl = process.env.NEUROBEATS_API_URL || "http://localhost:8041";

say(`→ Copie de web/ (lecture seule) vers ${src}`);
await fs.rm(src, { recursive: true, force: true });
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.dirname(src), { recursive: true });
await copyTree(path.join(root, "web"), src, {
  exclude: ["node_modules", ".next", "out", "build", ".env*", "*.tsbuildinfo", "next-env.d.ts"],
});

say("→ Patch du build standalone dans la COPIE uniquement");
await patchNextConfig(path.join(src, "next.config.ts"));

say("→ Installation des dependances (copie)");
// Les devDependencies sont indispensables au build (Turbopack, PostCSS,
// Tailwind) : un NODE_ENV=production herite du shell les fait sauter, et le
// build echoue ensuite sur « Cannot find module '@tailwindcss/postcss' ».
await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
  cwd: src,
  env: { ...process.env, NODE_ENV: "development" },
});

say(`→ Build Next (NEXT_PUBLIC_API_URL=${apiUrl})`);
// NODE_ENV explicite : le build doit etre celui de PRODUCTION quoi qu'il
// arrive. Un NODE_ENV=development fait echouer le prerender (React resout
// deux copies de lui-meme et `useContext` tombe sur null).
await run("npm", ["run", "build"], {
  cwd: src,
  env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_API_URL: apiUrl },
});

say("→ Assemblage du runtime standalone");
const standalone = path.join(src, ".next", "standalone");
if (!existsSync(standalone)) {
  console.error(
    "Erreur : pas de .next/standalone produit (output standalone non applique ?)",
  );
  process.exit(1);
}
await copyTree(standalone, dist);
await copyTree(path.join(src, ".next", "static"), path.join(dist, ".next", "static"));
if (existsSync(path.join(src, "public"))) {
  await copyTree(path.join(src, "public"), path.join(dist, "public"));
}

// electron-builder exclut par defaut tout dossier nomme node_modules, meme
// lorsqu'il se trouve dans extraResources. Le runtime standalone Next a besoin
// de ses modules ; on lui donne donc un nom neutre et frontend.ts injecte ce
// chemin via NODE_PATH au lancement du server.js.
const nested = path.join(dist, "node_modules");
if (existsSync(nested)) {
  await fs.rename(nested, path.join(dist, "web-node-modules"));
}

// Next grave dans ses metadonnees de build les chemins absolus de la machine
// (`outputFileTracingRoot`, `repoRoot`, `appDir`, `turbopack.root`). Ils ne
// sont jamais lus a l'execution, mais ils partent dans l'artefact public avec
// le nom d'utilisateur et l'arborescence du poste de dev. On les remplace par
// un chemin neutre : neutre car l'app sert ses fichiers via NODE_PATH, pas via
// ces champs, qui ne servent qu'au tracing de build.
say("→ Neutralisation des chemins de build dans le runtime standalone");
let replaced = 0;
for (const relative of ["server.js", path.join(".next", "required-server-files.json")]) {
  const file = path.join(dist, relative);
  if (!existsSync(file)) continue;
  const text = await fs.readFile(file, "utf8");
  if (!text.includes(desktop)) continue;
  await fs.writeFile(file, text.split(desktop).join("/app"), "utf8");
  replaced += 1;
}
say(`  ${replaced} fichier(s) neutralise(s)`);

say(`✓ Standalone pret : ${dist}`);
say(`  Lancer : npm run build && NEUROBEATS_STANDALONE_DIR="${dist}" npm run start`);

/**
 * Ajoute `output: "standalone"` et desactive l'optimiseur d'images.
 *
 * L'AppImage est un squashfs en lecture seule : le cache d'images de Next y
 * echoue (ENOENT a chaque requete, avec un unhandledRejection dans le
 * journal). Le conteneur desktop sert les jaquettes en direct — l'optimiseur
 * Node n'apporte rien ici et coute du CPU sur chaque image.
 */
async function patchNextConfig(file) {
  const source = await fs.readFile(file, "utf8");
  const lines = source.split("\n");
  let patched = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*export default (\w+);\s*$/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    const injected = [];
    if (!/\.output\s*=/.test(source)) {
      injected.push(`${name}.output = 'standalone';`);
    }
    injected.push(
      `${name}.images = { ...(${name}.images ?? {}), unoptimized: true };`,
    );
    lines.splice(index, 1, ...injected, `export default ${name};`);
    patched = true;
    break;
  }
  if (!patched) {
    throw new Error(
      "Erreur : next.config.ts sans « export default <nom>; » exploitable",
    );
  }
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
}
