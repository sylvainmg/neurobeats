import type { TextStyle, ViewStyle } from "react-native";

/**
 * Jetons de design, repris de la maquette validée (mobile/prototype.html).
 *
 * La maquette est la référence : les rayons, les bordures, les ombres et les
 * dégradés sont ceux de sa feuille de style, pas des valeurs approchées. Quand
 * un chiffre y est illustratif (les jauges), c'est le code qui lui donne un sens
 * — jamais l'inverse.
 *
 * Les contrastes sont ceux de l'audit : `ink2` (5,61:1) est le seul niveau
 * acceptable pour du texte secondaire ; `ink3` (3,13:1) est réservé aux hairlines
 * et aux éléments décoratifs — jamais du texte, même si la maquette l'y emploie.
 */
export const colors = {
  canvas: "#0f1419",
  surface: "#1a1f2a",
  surface2: "#222836",
  ink: "#f5f7fa",
  ink2: "#98a2b8",
  ink3: "#6b7688",
  primary: "#0066ff",
  accent: "#00d9ff",
  onPrimary: "#ffffff",
  border: "rgba(255,255,255,0.08)",
  /** Bordure des surfaces qui doivent se détacher : capsule de nav, feuille, mini-lecteur. */
  borderFort: "rgba(255,255,255,0.14)",
  /** Fond des boutons fantômes et des pastilles neutres. */
  voileClair: "rgba(255,255,255,0.06)",
  scrim: "rgba(0,0,0,0.62)",
  ok: "#2ed9a8",
  warn: "#ffb020",
  danger: "#ff6b6b",
} as const;

/** Rythme 4/8. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 36,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  /** La capsule de navigation est la seule surface à coins de 24. */
  nav: 24,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: "800" },
  /** Titre d'écran : « Bibliothèque », « Réglages » (`.top h3`). */
  ecran: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.44 },
  /** Titre d'une feuille : le nom de la playlist à importer. */
  feuille: { fontSize: 19, lineHeight: 24, fontWeight: "800", letterSpacing: -0.38 },
  /** Titre d'un écran vide, qui enseigne au lieu de s'excuser. */
  vide: { fontSize: 19, lineHeight: 24, fontWeight: "700", letterSpacing: -0.28 },
  /** Le grand chiffre d'une mesure : « 42 % ». */
  chiffre: { fontSize: 17, lineHeight: 22, fontWeight: "800", letterSpacing: -0.17 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "500" },
  /** Une valeur mesurée qui compte : « 310 Mo », « 14 titres ». */
  valeur: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  /** Titre d'une ligne de liste. */
  ligne: { fontSize: 14, lineHeight: 19, fontWeight: "500" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  /** Libellé de section : petites capitales espacées. */
  section: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  /** Explication sous une mesure : un peu plus d'air entre les lignes. */
  note: { fontSize: 12, lineHeight: 17, fontWeight: "500" },
} as const;

/** Chiffres tabulaires : c'est une interface de mesures. */
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

/** Courbe d'animation de la maquette, la même partout. */
export const ease = [0.22, 1, 0.36, 1] as const;

/**
 * Ombres portées.
 *
 * Les surfaces pleines de la maquette se détachent du fond au lieu de se
 * contenter d'une bordure : c'est ce qui donne la profondeur de la capsule de
 * navigation, du bouton de lecture et du bouton flottant.
 */
export const ombre: Record<"bouton" | "nav" | "fab" | "lecture" | "pochette", ViewStyle> = {
  bouton: {
    shadowColor: colors.primary,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  nav: {
    shadowColor: "#000000",
    shadowOpacity: 0.5,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 16 },
    elevation: 14,
  },
  fab: {
    shadowColor: colors.primary,
    shadowOpacity: 0.45,
    shadowRadius: 34,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  lecture: {
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  pochette: {
    shadowColor: "#000000",
    shadowOpacity: 0.45,
    shadowRadius: 44,
    shadowOffset: { width: 0, height: 20 },
    elevation: 12,
  },
};

/** Dégradés linéaires de la maquette (les positions se passent à l'usage). */
export const degrade = {
  /** Bande de possession : le bleu primaire qui glisse vers l'accent. */
  bande: ["rgba(0,102,255,0.18)", "rgba(0,217,255,0.07)"],
  /** Capsule de navigation : presque opaque, plus claire en haut. */
  nav: ["rgba(36,43,58,0.94)", "rgba(21,26,37,0.97)"],
  /** Vignette d'un titre sans pochette. */
  vignette: ["#24304a", "#17202f"],
  /** Le voile d'accent posé sur les vignettes. */
  vignetteVoile: ["rgba(0,217,255,0.16)", "rgba(0,217,255,0)"],
  /** La marque de l'écran vide. */
  marque: ["#0066ff", "#00d9ff"],
  /** La pochette du lecteur. */
  pochette: ["#2a3550", "#101722"],
} as const;

/** Une famille d'icônes, contour 1,8, boîte 24. */
export const icon = {
  size: 24,
  stroke: 1.8,
} as const;

/** Cibles tactiles : jamais moins de 48 dp. */
export const touch = {
  min: 48,
  navItem: 56,
  navPill: { width: 56, height: 32 },
} as const;
