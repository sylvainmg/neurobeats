/**
 * SHA-256 en TypeScript pur.
 *
 * Pourquoi ne pas `node:crypto` ou `expo-crypto` : le premier n'existe pas sur
 * React Native, le second n'est pas une dépendance du projet. Or la vérification
 * d'empreinte conditionne l'exécution d'un fichier téléchargé — on ne peut pas
 * la laisser dépendre d'un module natif qu'un jour quelqu'un débranchera, et on
 * ne peut pas se permettre d'ajouter une dépendance native à cette étape.
 *
 * Cette implémentation sert donc l'application mobile. Le desktop garde
 * `node:crypto`, natif et plus rapide : les deux comparent le condensat avec la
 * même fonction de `integrite.ts`, donc un écart d'implémentation se verrait
 * immédiatement dans les tests de vecteurs.
 *
 * Le code suit FIPS 180-4. Il est volontairement lisible plutôt que rapide :
 * il tourne sur quelques mégaoctets, une fois, quand l'utilisateur demande une
 * mise à jour.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function versOctets(source: Uint8Array): Uint8Array {
  // Padding : 0x80, puis des zéros, puis la longueur en bits sur 8 octets (big
  // endian). Le nombre de blocs doit donc tenir compte de ces 8 DERNIERS octets :
  // ignorer ce suffixe ne marche que par chance, et casse dès que les données
  // remplissent le dernier bloc (56 octets, par exemple, doivent produire deux
  // blocs, pas un).
  const longueur = source.length;
  const taille = Math.ceil((longueur + 1 + 8) / 64) * 64;
  const sortie = new Uint8Array(taille);
  sortie.set(source);
  sortie[longueur] = 0x80;
  const bits = longueur * 8;
  // La longueur ne tient pas sur 32 bits : on écrit les 8 octets de la gauche,
  // le calcul se faisant en number (sûr jusqu'à 2^53).
  const vue = new DataView(sortie.buffer);
  vue.setUint32(taille - 8, Math.floor(bits / 0x100000000), false);
  vue.setUint32(taille - 4, bits >>> 0, false);
  return sortie;
}

function rotationDroite(valeur: number, decalage: number): number {
  return ((valeur >>> decalage) | (valeur << (32 - decalage))) >>> 0;
}

/** SHA-256 d'un tableau d'octets, en hexadécimal minuscule. */
export function sha256(source: Uint8Array): string {
  const donnees = versOctets(source);
  const etat = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const vue = new DataView(donnees.buffer, donnees.byteOffset, donnees.byteLength);

  for (let bloc = 0; bloc < donnees.length; bloc += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = vue.getUint32(bloc + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        (rotationDroite(w[i - 15], 7) ^ rotationDroite(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 =
        (rotationDroite(w[i - 2], 17) ^ rotationDroite(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = etat[0];
    let b = etat[1];
    let c = etat[2];
    let d = etat[3];
    let e = etat[4];
    let f = etat[5];
    let g = etat[6];
    let h = etat[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotationDroite(e, 6) ^ rotationDroite(e, 11) ^ rotationDroite(e, 25)) >>> 0;
      const choix = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + choix + K[i] + w[i]) >>> 0;
      const S0 = (rotationDroite(a, 2) ^ rotationDroite(a, 13) ^ rotationDroite(a, 22)) >>> 0;
      const majorite = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + majorite) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    etat[0] = (etat[0] + a) >>> 0;
    etat[1] = (etat[1] + b) >>> 0;
    etat[2] = (etat[2] + c) >>> 0;
    etat[3] = (etat[3] + d) >>> 0;
    etat[4] = (etat[4] + e) >>> 0;
    etat[5] = (etat[5] + f) >>> 0;
    etat[6] = (etat[6] + g) >>> 0;
    etat[7] = (etat[7] + h) >>> 0;
  }

  let hex = "";
  for (const mot of etat) hex += mot.toString(16).padStart(8, "0");
  return hex;
}

/** SHA-256 d'une chaîne UTF-8. Pratique pour les tests et les petits fichiers. */
export function sha256Texte(texte: string): string {
  return sha256(new TextEncoder().encode(texte));
}
