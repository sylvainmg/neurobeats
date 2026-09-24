/**
 * Famille d'icônes unique : contour 1,8, boîte 24, tracés dessinés (jamais une
 * police ni un emoji — une police n'est pas un jeu d'icônes, et ses glyphes
 * changent d'un appareil à l'autre).
 *
 * Les tracés sont ceux de la maquette (`mobile/prototype.html`), au trait près.
 * Le transport du lecteur est le seul endroit où l'on remplit : la maquette y
 * montre des pictogrammes pleins, parce qu'ils se lisent d'un coup d'œil sous le
 * pouce.
 */
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { icon as iconTokens, colors } from "@/theme/tokens";

export type IconProps = {
  size?: number;
  color?: string;
  /** Pictogramme plein (transport) plutôt que tracé. */
  rempli?: boolean;
};

type Props = IconProps & { children: React.ReactNode };

function Glyph({ size = iconTokens.size, color = "#f5f7fa", rempli = false, children }: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={rempli ? color : "none"}
      stroke={rempli ? "none" : color}
      strokeWidth={iconTokens.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      {children}
    </Svg>
  );
}

/** Le code à scanner : trois carrés et un coin ouvert. */
export function IconCodeQr(props: IconProps) {
  return (
    <Glyph {...props}>
      <Rect x="3" y="3" width="7" height="7" rx="1.5" />
      <Rect x="14" y="3" width="7" height="7" rx="1.5" />
      <Rect x="3" y="14" width="7" height="7" rx="1.5" />
      <Path d="M14 14h3v3M20 20h1" />
    </Glyph>
  );
}

/** Bibliothèque : les notes. */
export function IconLibrary(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M9 18V6l10-2v12" />
      <Circle cx="6.5" cy="18" r="2.5" />
      <Circle cx="16.5" cy="16" r="2.5" />
    </Glyph>
  );
}

/** Téléchargements : la flèche qui descend dans le plateau. */
export function IconDownloads(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M12 4v10" />
      <Path d="m12 14 4-4m-4 4-4-4" />
      <Path d="M5 19h14" />
    </Glyph>
  );
}

/**
 * Titre téléchargé en local : le disque avec flèche vers le bas des apps de
 * musique (Spotify, Apple Music). Le disque est rond et plein, la flèche dans
 * la couleur de fond pour rester lisible quelle que soit la vignette.
 */
export function IconTelecharge(props: IconProps) {
  const trait = colors.canvas;
  return (
    <Svg
      width={props.size ?? iconTokens.size}
      height={props.size ?? iconTokens.size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={iconTokens.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      <Circle cx="12" cy="12" r="8.2" fill={props.color ?? colors.ok} stroke="none" />
      <Path d="M12 8.4v6" stroke={trait} />
      <Path d="m8.9 11.9 3.1 3 3.1-3" stroke={trait} />
    </Svg>
  );
}

/** Navigateur : la boussole, pointe vers la découverte. */
export function IconNavigateur(props: IconProps) {
  return (
    <Glyph {...props}>
      <Circle cx="12" cy="12" r="8.2" />
      <Path d="m14.8 9.2-1.4 4.2-4.2 1.4 1.4-4.2z" />
    </Glyph>
  );
}

/** Réglages : les curseurs. */
export function IconSettings(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4 8h2.6M11.4 8H20M4 16h8.6M17.4 16H20" />
      <Circle cx="9" cy="8" r="2.4" />
      <Circle cx="15" cy="16" r="2.4" />
    </Glyph>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Glyph {...props}>
      <Circle cx="11" cy="11" r="6" />
      <Path d="m15.6 15.6 3.4 3.4" />
    </Glyph>
  );
}

export function IconScan(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4 8.5V6.5A2.5 2.5 0 0 1 6.5 4h2M15.5 4h2A2.5 2.5 0 0 1 20 6.5v2M20 15.5v2a2.5 2.5 0 0 1-2.5 2.5h-2M8.5 20h-2A2.5 2.5 0 0 1 4 17.5v-2" />
      <Path d="M4.5 12h15" />
    </Glyph>
  );
}

/** La lampe du scanner. */
export function IconLampe(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M9 3h6v4l-1.5 3v11h-3V10L9 7z" />
      <Path d="M12 2v1" />
    </Glyph>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M8 5.5 18 12 8 18.5z" />
    </Glyph>
  );
}

export function IconPause({ rempli, ...props }: IconProps) {
  return (
    <Glyph {...props} rempli={rempli}>
      {rempli ? <Path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <Path d="M9.5 5.5v13M14.5 5.5v13" />}
    </Glyph>
  );
}

export function IconNext({ rempli, ...props }: IconProps) {
  return (
    <Glyph {...props} rempli={rempli}>
      {rempli ? (
        <Path d="M16 5h2v14h-2zM6 6l9 6-9 6z" />
      ) : (
        <>
          <Path d="M6 5.5 15 12 6 18.5z" />
          <Path d="M18 5.5v13" />
        </>
      )}
    </Glyph>
  );
}

export function IconPrevious({ rempli, ...props }: IconProps) {
  return (
    <Glyph {...props} rempli={rempli}>
      {rempli ? (
        // Triangle pointant vers la barre (recul) : la version tracée a la même
        // orientation, la pleine la regardait dans l'autre sens.
        <Path d="M6 5h2v14H6zm3 7 9-7 0 14z" />
      ) : (
        <>
          <Path d="M18 5.5 9 12l9 6.5z" />
          <Path d="M6 5.5v13" />
        </>
      )}
    </Glyph>
  );
}

/** Reculer de quinze secondes. */
export function IconReculer15(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M11 5 6 9l5 4z" />
      <Path d="M6 9h7a6 6 0 0 1 0 12" />
    </Glyph>
  );
}

/** Avancer de quinze secondes. */
export function IconAvancer15(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="m13 5 5 4-5 4z" />
      <Path d="M18 9h-7a6 6 0 0 0 0 12" />
    </Glyph>
  );
}

/** Lecture aléatoire. */
export function IconAleatoire(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4 7h4l8 10h4M4 17h4l3-3.5M17 4l3 3-3 3M17 14l3 3-3 3" />
    </Glyph>
  );
}

/** Répéter. */
export function IconRepeter(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4" />
    </Glyph>
  );
}

/** Deux flèches qui se rattrapent : l'état posé, une fois la playlist
 * arrivée. Le même tracé sert quand un transfert vient de finir. */
export function IconSync(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <Path d="M21 3v5h-5" />
      <Path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <Path d="M8 16H3v5" />
    </Glyph>
  );
}

export function IconHalf(props: IconProps) {
  return (
    <Glyph {...props}>
      <Circle cx="12" cy="12" r="7.5" />
      <Path d="M12 4.5v15" />
      <Path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />
    </Glyph>
  );
}

export function IconCloudDown(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M7 17.5a3.8 3.8 0 0 1-.3-7.6 5.2 5.2 0 0 1 10 .8A3.4 3.4 0 0 1 16.6 17.5" />
      <Path d="M12 11.5V19" />
      <Path d="m9.5 16.5 2.5 2.5 2.5-2.5" />
    </Glyph>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M12 4.5 20.5 19.5H3.5z" />
      <Path d="M12 10v4.2" />
      <Path d="M12 17.2h.01" />
    </Glyph>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Glyph>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M14.5 5.5 8 12l6.5 6.5" />
    </Glyph>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M9.5 5.5 16 12l-6.5 6.5" />
    </Glyph>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M12 5.5v13M5.5 12h13" />
    </Glyph>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4.5 19.5 5.9 15l9.6-9.7a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L9.1 18.1l-4.6 1.4z" />
      <Path d="m14 6.8 3.2 3.2" />
    </Glyph>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M5.5 7.5h13" />
      <Path d="M9.5 7.5V5.5h5v2" />
      <Path d="M7 7.5 7.8 19a1.5 1.5 0 0 0 1.5 1.4h5.4A1.5 1.5 0 0 0 16.2 19L17 7.5" />
    </Glyph>
  );
}

export function IconWifi(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4.5 9.5a11 11 0 0 1 15 0" />
      <Path d="M7.5 12.8a7 7 0 0 1 9 0" />
      <Path d="M10.4 16a3 3 0 0 1 3.2 0" />
      <Path d="M12 19h.01" />
    </Glyph>
  );
}

export function IconOffline(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4.5 9.5a11 11 0 0 1 5.2-2.7" />
      <Path d="M14.6 7a11 11 0 0 1 4.9 2.5" />
      <Path d="M7.5 12.8a7 7 0 0 1 3-1.6" />
      <Path d="M4 4l16 16" />
      <Path d="M12 19h.01" />
    </Glyph>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Glyph {...props}>
      <Circle cx="12" cy="12" r="7.5" />
      <Path d="M12 7.5V12l3 2" />
    </Glyph>
  );
}

export function IconQueue(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M4 7h11M4 12h11M4 17h7" />
      <Circle cx="18" cy="16" r="2.5" />
      <Path d="M20.5 16V8.5l-3 .8" />
    </Glyph>
  );
}

export function IconPaste(props: IconProps) {
  return (
    <Glyph {...props}>
      <Rect x="6" y="5" width="12" height="15" rx="2" />
      <Path d="M9.5 5V4a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 4v1" />
      <Path d="M9.5 12h5M9.5 15.5h3" />
    </Glyph>
  );
}

export function IconHeart(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="M12 19s-6.5-3.8-6.5-8.2A3.8 3.8 0 0 1 12 8.2a3.8 3.8 0 0 1 6.5 2.6C18.5 15.2 12 19 12 19z" />
    </Glyph>
  );
}

/**
 * Partager : trois points reliés par un trait, la figure du « envoyer à
 * quelqu'un ». La direction sort de l'écran (haut-droite), pas dans le disque.
 */
export function IconPartage(props: IconProps) {
  return (
    <Glyph {...props}>
      <Circle cx="6" cy="12" r="2.2" />
      <Circle cx="18" cy="6" r="2.2" />
      <Circle cx="18" cy="18" r="2.2" />
      <Path d="m8.1 11 7.8-4.1M8.1 13l7.8 4.1" />
    </Glyph>
  );
}

/** Cocher une case : la confirmation d'un choix, dans les sélections. */
export function IconCheck(props: IconProps) {
  return (
    <Glyph {...props}>
      <Path d="m5.5 12.5 4.2 4L18.5 8" />
    </Glyph>
  );
}
