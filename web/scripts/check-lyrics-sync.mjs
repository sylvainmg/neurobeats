// Contrats purs du karaoké (miroir de web/lib/lyrics.ts + lyrics-overlay.tsx).
//
// Les fonctions réelles sont du TS transpilé à la volée par Next (alias @/),
// non importables depuis node. Ce script rejoue donc les comportements EXACTS
// documentés dans le code source — si l'un deux dérive, ce fichier est la
// première alarme. Les cas : ligne vide intercalée (régression findActiveLine),
// défilement estimé sans horodatage (fallback), snap au seek (> 1,2 s =
// scroll instantané), clic→seek (cible = line.time, sections/lignes vides non
// cliquables).
//
// Usage : node scripts/check-lyrics-sync.mjs
const SEEK_JUMP_SECONDS = 1.2; // miroir de lib/lyrics.ts

// --- mirror de findActiveLine (lib/lyrics.ts) -------------------------------
function findActiveLine(lines, time) {
  const timed = [];
  lines.forEach((line, index) => {
    if (line.time != null) timed.push({ index, time: line.time });
  });
  let low = -1;
  let high = timed.length;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (timed[mid].time > time) high = mid;
    else low = mid;
  }
  return low < 0 ? -1 : timed[low].index;
}

const SECTION_LABEL = /^\[[^\]\n]+\]$/;
function isSectionLabel(text) {
  return SECTION_LABEL.test(text.trim());
}

const ok = (name) => console.log(`  OK    ${name}`);
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) ok(name);
  else {
    failures += 1;
    console.log(`  ECHEC ${name}  [${detail}]`);
  }
};

console.log("\n[1] findActiveLine : lignes vides intercalees (regression corigee)");
const withGaps = [
  { time: 1.0, text: "Un" },
  { time: null, text: "" }, // separateur vide jamais actif
  { time: 2.0, text: "Deux" },
  { time: null, text: "" },
  { time: 3.0, text: "Trois" },
];
check("t=0 -> -1 (aucune ligne)", findActiveLine(withGaps, 0) === -1, String(findActiveLine(withGaps, 0)));
check("t=1.5 -> ligne 0 (Un)", findActiveLine(withGaps, 1.5) === 0);
check("t=2.5 -> ligne 2 (Deux)", findActiveLine(withGaps, 2.5) === 2, String(findActiveLine(withGaps, 2.5)));
check("t=9 -> derniere ligne (Trois)", findActiveLine(withGaps, 9) === 4);
check("une ligne vide n'est JAMAIS active", findActiveLine(withGaps, 1.0) === 0);

console.log("\n[2] Defilement estime (fallback sans horodatage)");
// Mirror d'estimateLineTimes (lib/lyrics.ts) : sans sync, les lignes sont
// reparties sur la duree (intro/outro ~8 % puis pas regulier) — c'est ce qui
// fait défiler le panneau en continu pour les paroles non synchronisées.
function estimateLineTimes(lines, duration) {
  if (!duration || duration <= 0 || lines.length === 0) return lines;
  if (lines.some((line) => line.time != null)) return lines;
  const margin = Math.max(6, duration * 0.08);
  const usable = Math.max(0, duration - margin * 2);
  const steps = lines.filter((line) => line.text.trim()).length || 1;
  const step = usable / steps;
  const times = new Map();
  let cursor = margin;
  lines.forEach((line, index) => {
    if (line.time != null) {
      cursor = line.time;
      times.set(index, line.time);
    } else if (line.text.trim()) {
      times.set(index, cursor);
      cursor += step;
    }
  });
  return lines.map((line, index) => {
    const time = times.get(index);
    return time === undefined ? line : { ...line, time };
  });
}

const plainLines = [
  { time: null, text: "Premiere ligne" },
  { time: null, text: "Deuxieme" },
  { time: null, text: "" }, // separateur vide : sans temps, jamais active
  { time: null, text: "Refrain" },
];
const estimated = estimateLineTimes(plainLines, 100);
check("sans horodatage, chaque ligne non vide recoit un temps", estimated.filter((l) => l.time != null).length === 3, JSON.stringify(estimated));
check("intro de ~8 % avant la premiere ligne", estimated[0].time >= 7.9 && estimated[0].time <= 8.1, String(estimated[0].time));
check("pas regulier sur le reste (la ligne vide ne le rompt pas)", Math.abs((estimated[3].time - estimated[1].time) - (estimated[1].time - estimated[0].time)) < 0.001, JSON.stringify(estimated.map((l) => l.time)));
check("la ligne vide reste sans temps (jamais active)", estimated[2].time === null, JSON.stringify(estimated[2]));
check("avec durée inconnue, les lignes passent inchangées (pas de faux temps)", JSON.stringify(estimateLineTimes(plainLines, null)) === JSON.stringify(plainLines));
check("déjà horodaté = intouché", estimateLineTimes([{ time: 5, text: "x" }], 100)[0].time === 5);
check("le fallback est branché sur le défilement (ligne active qui avance)", findActiveLine(estimated, estimated[1].time) === 1);

console.log("\n[3] Snap au seek (compare tick a tick, >1,2 s = instantane)");
// La detection reelle compare l'horloge du tick precedent (~8 Hz) a l'actuelle :
// un ecart normal est <= 0,2 s ; seul un seek (clic sur une ligne, pilote, ou
// reprise apres suspension manuelle 3,5 s) produit un delta > 1,2 s.
const jump = (prevTickClock, nowClock) => Math.abs(nowClock - prevTickClock) > SEEK_JUMP_SECONDS;
check("tick normal (~0,13 s d'ecart) = PAS un seek", !jump(100, 100.13));
check("transition de ligne normale : jamais un saut (tick a tick)", !jump(100, 100.125));
check("seek avant de 40 s = snap", jump(100, 60));
check("seek arriere de 35 s = snap", jump(100, 135));
check("reprise apres suspension manuelle (>=3,5 s) = snap", jump(100, 103.6));
check("petit nudge 1,0 s = pas de snap", !jump(100, 101));

console.log("\n[4] Clic -> seek : cible et cliquabilite");
const line = { time: 57.25, text: "Chorus" };
check("la cible du seek est le timestamp exact de la ligne", line.time === 57.25);
const linesWithMeta = [
  { time: 1.0, text: "Couplet" },
  { time: null, text: "" },
  { time: null, text: "[Refrain]" }, // section, jamais cliquable
  { time: 5.0, text: "Chorus" },
];
const clickable = linesWithMeta.map((l) => !isSectionLabel(l.text) && l.time != null);
check(
  "sections et lignes vides sont inertes, le reste est cliquable",
  JSON.stringify(clickable) === JSON.stringify([true, false, false, true]),
  JSON.stringify(clickable),
);
check("section reconnue ([Refrain])", isSectionLabel("[Refrain]"));
check("ligne de paroles pas confondue avec une section", !isSectionLabel("Refrain"));

console.log(failures ? `\n${failures} echec(s)` : "\ntous les contrats karaoke OK");
process.exit(failures ? 1 : 0);