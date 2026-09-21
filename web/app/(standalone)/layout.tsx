/**
 * Layout hors application : plein écran, sans sidebar ni player.
 *
 * La hauteur est fixée au viewport (`h-dvh`) pour que les pages donnent une
 * hauteur définie à leurs panneaux : ceux-ci remplissent l'écran et gèrent
 * eux-mêmes leur défilement, plutôt que d'étirer la fenêtre.
 */
export default function StandaloneLayout({ children }: LayoutProps<"/">) {
  return <div className="h-dvh overflow-hidden">{children}</div>;
}
