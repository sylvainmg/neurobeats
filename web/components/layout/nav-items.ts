import { Compass, Home, Library, Search } from "lucide-react";

/**
 * Navigation principale de l'application.
 *
 * Source unique pour la sidebar desktop et le drawer mobile : déclarer une
 * route ici la rend disponible partout, sans duplication entre les deux
 * rendus.
 */
export const NAV = [
  { href: "/", label: "Accueil", icon: Home },
  { href: "/search", label: "Recherche", icon: Search },
  { href: "/discover", label: "Découvrir", icon: Compass },
  { href: "/library", label: "Bibliothèque", icon: Library },
] as const;