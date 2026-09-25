"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  BrainCircuit,
  ChevronRight,
  Clock,
  Database,
  History,
  Music2,
  Pencil,
  SkipForward,
  Sparkles,
  Star,
  Trash2,
  User,
  Users,
  Wrench,
  X,
} from "lucide-react";

import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AvatarPicker } from "@/components/profile/avatar-picker";
import { AiSettingsForm } from "@/components/profile/ai-settings";
import { FavoritesDialog } from "@/components/profile/favorites-dialog";
import { HistoryDialog } from "@/components/profile/history-dialog";
import { IdentityDialog } from "@/components/profile/identity-dialog";
import { RatingsDialog } from "@/components/profile/ratings-dialog";
import { TasteAssistant } from "@/components/profile/taste-assistant";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "cn";

// Onglets du profil : une seule section affichee a la fois, pour aerer.
const TABS = [
  { id: "identite", label: "Identité", icon: User },
  { id: "assistant", label: "Assistant", icon: Sparkles },
  { id: "ia", label: "IA", icon: BrainCircuit },
  { id: "donnees", label: "Données", icon: Database },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Le dialogue « Mes notes » fenêtre un palier à la fois : le DOM ne recoit
 * jamais toute la liste d'un coup, même à des milliers de notes. */
const NOTICE_MS = 4300; // juste apres la fin de l'animation nb-notice (4200 ms)

/** Aperçu d'artistes favoris affiché dans la carte : le reste — potentiellement
 * long — s'explore dans FavoritesDialog (recherche + roulement au scroll). */
const FAVORITES_PREVIEW = 8;

/** Ordre d'affichage des paliers de note, du plus fort au plus faible. */
const RATING_ORDER = [5, 4, 3, 2, 1] as const;

/** Libellé d'un palier de note, du plus fort au plus faible. */
const RATING_LABELS: Record<number, string> = {
  5: "Chefs-d'œuvre",
  4: "Titres aimés",
  3: "Titres corrects",
  2: "Titres moyens",
  1: "Titres peu appréciés",
};

/**
 * Libellés des créneaux d'écoute.
 *
 * Le moteur stocke des identifiants bruts (`soir`, `apres-midi`…) : ils servent
 * de clés en base, on ne les affiche donc pas tels quels.
 */
const SLOT_LABELS: Record<string, string> = {
  matin: "Matin",
  midi: "Midi",
  "apres-midi": "Après-midi",
  soir: "Soir",
  nuit: "Nuit",
};

function slotLabel(slot?: string | null): string {
  if (!slot) return "—";
  return SLOT_LABELS[slot] ?? slot.charAt(0).toUpperCase() + slot.slice(1);
}

/** Bloc de resume navigable : la valeur porte le regard, le clic ouvre l'onglet
 * correspondant (notes et favoris vivent dans l'onglet Donnees, les ecoutes
 * dans l'historique de Donnees). */
function SummaryAction({
  icon: Icon,
  value,
  label,
  target,
  onNavigate,
}: {
  icon: typeof User;
  value: string;
  label: string;
  target: TabId;
  onNavigate: (tab: TabId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(target)}
      aria-label={`${label} : ${value}. Ouvrir l'onglet ${
        TABS.find((tab) => tab.id === target)?.label ?? ""
      }`}
      className="bg-background/50 border-border/70 hover:border-border hover:bg-background/80 focus-visible:ring-ring/60 group rounded-xl border p-4 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
    >
      <span className="text-muted-foreground flex items-center justify-between">
        <Icon className="size-5" aria-hidden="true" />
        <ChevronRight
          className="text-muted-foreground/70 size-4 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{label}</p>
    </button>
  );
}

/** Tête de zone (onglet Données) : libellé + filet, pour séparer les groupes. */
function SectionHeading({
  id,
  icon: Icon,
  label,
  hint,
  className,
}: {
  id: string;
  icon: typeof User;
  label: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Icon
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      <h2 id={id} className="text-sm font-semibold">
        {label}
      </h2>
      {hint && (
        <span className="text-muted-foreground hidden text-xs sm:inline">
          {hint}
        </span>
      )}
      <span aria-hidden="true" className="bg-border h-px flex-1" />
    </div>
  );
}

/**
 * Carte de données : même en-tête partout (icône, titre, compteur, action) pour
 * que chaque bloc se scanne de la même façon, quel que soit son contenu.
 */
function DataCard({
  icon: Icon,
  title,
  count,
  action,
  children,
  className,
}: {
  icon: typeof User;
  title: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "bg-surface border-border overflow-hidden rounded-xl border",
        className,
      )}
    >
      <header className="border-border/60 flex items-center gap-3 border-b px-4 py-3">
        <span className="bg-background/60 text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h3>
        {count && (
          <span className="bg-background/60 text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums">
            {count}
          </span>
        )}
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof User;
  value: string;
  label: string;
}) {
  return (
    <div className="bg-background/50 border-border/70 rounded-xl border p-4">
      <Icon className="text-muted-foreground size-5" />
      <p className="mt-2 truncate text-xl font-bold tabular-nums" title={value}>
        {value}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">{label}</p>
    </div>
  );
}

/** Page Profil : identité (+ stats d'écoute), assistant des goûts, données récoltées. */
export function ProfileView() {
  // Source unique : profil, notes, favoris et historique viennent du store, qui se
  // resynchronise sur les revisions serveur. Aucune copie locale dans la page.
  const {
    profile,
    error,
    ratings,
    favorites,
    refreshProfile,
  } = useStore();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(
    null,
  );
  const [editIdentity, setEditIdentity] = useState(false);
  const [confirmKind, setConfirmKind] = useState<
    null | "history" | "caches" | "avatar"
  >(null);
  // Modal historique : la liste complete, dedoublonnee, y est visible.
  const [historyDialog, setHistoryDialog] = useState(false);
  // Modal notes : toute la liste s'y consulte (recherche + roulement au
  // scroll) ; la carte n'affiche que la repartition par palier.
  const [ratingsDialog, setRatingsDialog] = useState(false);
  // Modal artistes favoris : apercu borne dans la carte, liste complete ici.
  const [favoritesDialog, setFavoritesDialog] = useState(false);
  // `id` force le redemarrage de l'animation quand un nouveau message remplace
  // l'ancien.
  const noticeSeq = useRef(0);
  // Ouverture directe sur un onglet (ex. Profil → IA depuis le bandeau du chat).
  // Initialisation différée : pas de SSR (window absent) ni d'effet à setState.
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "identite";
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return wanted && TABS.some((item) => item.id === wanted)
      ? (wanted as TabId)
      : "identite";
  });
  // L'onglet suit AUSSI les navigations suivantes : depuis cette page, le
  // bandeau « Configurer » pointe sur `?tab=ia` — sans cette synchronisation le
  // lien changeait l'URL sans rien afficher (le composant est déjà monté).
  const urlTab = useSearchParams().get("tab");
  useEffect(() => {
    if (urlTab && TABS.some((item) => item.id === urlTab)) {
      setTab(urlTab as TabId);
    }
  }, [urlTab]);

  /** Confirmation ephemere : elle s'efface seule apres quelques secondes. */
  const showNotice = useCallback((text: string) => {
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, text });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Repartition des notes par palier : affichee en resume sur la carte (la
  // valeur et l'etoile sautent aux yeux) sans lister les titres bruts — ils se
  // consultent dans le dialogue, ouvert par le bouton dedie.
  const tierCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const rated of ratings) {
      counts.set(rated.rating, (counts.get(rated.rating) ?? 0) + 1);
    }
    return counts;
  }, [ratings]);

  const identity = profile?.identity;
  const stats = profile?.stats;
  const overview = profile?.overview;

  async function saveIdentity(values: {
    first_name: string;
    last_name: string;
  }): Promise<boolean> {
    setBusy(true);
    try {
      await api.updateProfile(values);
      await refreshProfile();
      showNotice("Identité enregistrée.");
      return true;
    } catch (err) {
      showNotice(
        err instanceof Error ? err.message : "Enregistrement impossible.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeAvatar(dataUrl: string) {
    setBusy(true);
    try {
      await api.setAvatar(dataUrl);
      await refreshProfile();
      showNotice("Photo mise à jour.");
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "Import impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function clearAvatar() {
    setBusy(true);
    try {
      await api.clearAvatar();
      await refreshProfile();
      showNotice("Photo retirée.");
    } finally {
      setBusy(false);
    }
  }

  async function removeListen(entryId: number) {
    await api.deleteHistoryEntry(entryId);
    await refreshProfile();
  }

  async function clearHistory() {
    const res = await api.clearHistory();
    showNotice(`${res.removed} écoute(s) supprimée(s).`);
    setHistoryDialog(false);
    await refreshProfile();
  }

  async function removeFavorite(channel: string) {
    await api.removeFavorite(channel);
    await refreshProfile();
  }

  async function clearCaches() {
    const res = await api.clearCaches();
    showNotice(
      `Caches vidés (${res.removed.genres ?? 0} genres, ${res.removed.embeddings ?? 0} embeddings, ${res.removed.urls ?? 0} URLs).`,
    );
    await refreshProfile();
  }

  if (error && !profile) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <p role="alert" className="text-muted-foreground text-sm">
          {error}
        </p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-center gap-5">
          <span className="bg-surface-hover size-28 animate-pulse rounded-full" />
          <span className="space-y-3">
            <span className="bg-surface-hover block h-8 w-56 animate-pulse rounded-lg" />
            <span className="bg-surface-hover block h-3 w-40 animate-pulse rounded-full" />
          </span>
        </div>
      </div>
    );
  }

  const historyCount = overview?.history ?? 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      {/* Retour à l'application : cet écran est atteint depuis la barre du haut.
          `self-start` : le conteneur est une colonne flex, sinon le bouton
          s'étirerait sur toute la largeur (libellé centré). */}
      <BackButton href="/" className="self-start" />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabId)}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
          {/* Onglets centres : une seule section visible a la fois. Sur mobile,
              segments egaux pleine largeur (icones masquees, libelle seul). */}
          <TabsList aria-label="Sections du profil" className="w-full md:w-auto md:self-center">
            {TABS.map(({ id, label, icon: Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="max-sm:min-h-11 max-sm:flex-1 max-sm:justify-center max-sm:gap-1 max-sm:px-2 max-sm:text-xs"
              >
                <Icon className="size-4 max-sm:hidden" aria-hidden="true" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

        <TabsContent value="identite" className="flex flex-col overflow-y-auto overscroll-contain">
          {/* Carte d'identite : profil, stats d'ecoute, et resume navigable
              (ecoutes/notes/favoris) colle en bas. La carte est centree
              verticalement ; le resume reste ancre a sa base. */}
          <section
            aria-labelledby="identity-name"
            className="bg-surface border-border my-auto flex flex-col gap-4 rounded-xl border p-6 sm:p-8"
          >
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
              <AvatarPicker
                avatar={identity?.avatar ?? ""}
                displayName={identity?.display_name ?? ""}
                busy={busy}
                onChange={(dataUrl) => void changeAvatar(dataUrl)}
                onClear={() => setConfirmKind("avatar")}
              />

              <div className="min-w-0 flex-1 space-y-5 text-center sm:text-left">
                <h1
                  id="identity-name"
                  title={identity?.display_name || "Auditeur"}
                  className="max-w-full min-w-0 truncate text-3xl font-bold tracking-tight sm:text-4xl"
                >
                  {identity?.display_name || "Auditeur"}
                </h1>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditIdentity(true)}
                  className="rounded-full"
                >
                  <Pencil className="size-3.5" />
                  Modifier mon identité
                </Button>
              </div>
            </div>

            <div className="border-border/60 grid grid-cols-2 gap-4 border-t pt-4 lg:grid-cols-4">
              <StatCard
                icon={Music2}
                value={String(stats?.plays_total ?? 0)}
                label="Titres écoutés"
              />
              <StatCard
                icon={User}
                value={stats?.artiste_top?.channel ?? "—"}
                label="Artiste préféré"
              />
              <StatCard
                icon={Clock}
                value={slotLabel(stats?.heure_pref?.slot)}
                label="Créneau favori"
              />
              <StatCard
                icon={SkipForward}
                value={`${Math.round((stats?.skip_ratio ?? 0) * 100)} %`}
                label="Taux de skip"
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {overview?.playlists ?? 0} playlists ·{" "}
              {overview?.cached_genres ?? 0} genres analysés
              {stats?.duree_moyenne
                ? ` · durée moyenne ${Math.round(stats.duree_moyenne)} s`
                : ""}
            </p>

            <div className="border-border/60 grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-3">
              <SummaryAction
                icon={Music2}
                value={historyCount.toLocaleString("fr-FR")}
                label={historyCount > 1 ? "écoutes" : "écoute"}
                target="donnees"
                onNavigate={setTab}
              />
              <SummaryAction
                icon={Star}
                value={ratings.length.toLocaleString("fr-FR")}
                label={ratings.length > 1 ? "notes" : "note"}
                target="donnees"
                onNavigate={setTab}
              />
              <SummaryAction
                icon={Users}
                value={String(favorites.length)}
                label={
                  favorites.length > 1 ? "artistes favoris" : "artiste favori"
                }
                target="donnees"
                onNavigate={setTab}
              />
            </div>
          </section>
        </TabsContent>

        {/* Assistant dédié aux goûts : la conversation vit dans l'onglet. */}
        <TabsContent
          value="assistant"
          forceMount
          className="flex flex-col overflow-y-auto overscroll-contain data-[state=inactive]:hidden"
        >
          <TasteAssistant active={tab === "assistant"} />
        </TabsContent>

        {/* Modèle d'IA : fournisseur, URL, modèle, clé (masquée). */}
        <TabsContent value="ia" className="flex flex-col overflow-y-auto overscroll-contain">
          <div className="my-auto w-full space-y-8">
            <AiSettingsForm />
          </div>
        </TabsContent>

        {/* Mes données */}
        <TabsContent value="donnees" className="flex flex-col overflow-y-auto overscroll-contain">
          <div className="my-auto w-full space-y-8">
            {/* Zone 1 : les donnees que l'utilisateur consulte et gere.
                Deux colonnes des que l'ecran le permet : les cartes sont
                compactes (plus de liste inline), elles s'equilibrent. */}
            <section
              aria-labelledby="data-owned-title"
              className="grid gap-4 md:grid-cols-2"
            >
              <SectionHeading
                id="data-owned-title"
                icon={Database}
                label="Tes données"
                hint="Ce que le moteur a appris de toi"
                className="md:col-span-2"
              />

              <DataCard
                icon={History}
                title="Historique d'écoute"
                count={`${historyCount.toLocaleString("fr-FR")} écoute${historyCount > 1 ? "s" : ""}`}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={historyCount === 0}
                    onClick={() => setConfirmKind("history")}
                    className="text-muted-foreground hover:text-destructive rounded-full text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    Tout effacer
                  </Button>
                }
              >
                <p className="text-muted-foreground text-sm">
                  {historyCount === 0
                    ? "Aucune écoute enregistrée. Lance un titre depuis la recherche ou l’accueil."
                    : "Tout ton historique est ici, chaque titre sans doublon, prêt à être relancé."}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 rounded-full"
                  disabled={historyCount === 0}
                  onClick={() => setHistoryDialog(true)}
                >
                  <History className="size-4" />
                  Voir l’historique
                </Button>

                <HistoryDialog
                  open={historyDialog}
                  onOpenChange={setHistoryDialog}
                  totalPlays={historyCount}
                  onRemove={(entryId) => void removeListen(entryId)}
                />
              </DataCard>

              <DataCard
                icon={Star}
                title="Titres notés"
                count={`${ratings.length.toLocaleString("fr-FR")} note${ratings.length > 1 ? "s" : ""}`}
              >
                {ratings.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucune note pour l&apos;instant. Note un titre depuis la
                    recherche ou la barre de lecture pour le retrouver ici.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {/* Repartition par palier : l'echelle 5→1 tient en un coup
                        d'oeil (valeur + etoiles), les titres restent dans le
                        dialogue ouvert par le bouton dedie. */}
                    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {RATING_ORDER.map((tier) => {
                        const count = tierCounts.get(tier) ?? 0;
                        if (count === 0) return null;
                        return (
                          <li
                            key={tier}
                            title={RATING_LABELS[tier] ?? "Notés"}
                            className="bg-background/50 border-border/70 flex flex-col items-center gap-1 rounded-lg border p-2 text-center"
                          >
                            <span
                              className="text-primary flex items-center gap-0.5"
                              aria-hidden="true"
                            >
                              {Array.from({ length: tier }, (_, i) => (
                                <Star key={i} className="size-2.5 fill-current" />
                              ))}
                            </span>
                            <span className="text-lg font-bold leading-none tabular-nums">
                              {count.toLocaleString("fr-FR")}
                            </span>
                            <span className="text-muted-foreground max-w-full truncate text-xs">
                              {RATING_LABELS[tier] ?? "Notés"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRatingsDialog(true)}
                      className="rounded-full"
                    >
                      <Star className="size-4" />
                      Voir mes notes
                    </Button>
                  </div>
                )}

                <RatingsDialog
                  open={ratingsDialog}
                  onOpenChange={setRatingsDialog}
                />
              </DataCard>

              <DataCard
                icon={Users}
                title="Artistes favoris"
                count={String(favorites.length)}
                className="md:col-span-2"
              >
                {favorites.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucun favori — une note ★ ≥ 4 ajoute l&apos;artiste
                    automatiquement.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {/* Apercu borne : la liste complete (potentiellement
                        longue) s'explore dans le dialogue, comme les notes. */}
                    <ul className="flex flex-wrap gap-2">
                      {favorites.slice(0, FAVORITES_PREVIEW).map((channel) => (
                        <li key={channel}>
                          <span className="border-border flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
                            {channel}
                            <button
                              type="button"
                              aria-label={`Retirer ${channel} des favoris`}
                              onClick={() => void removeFavorite(channel)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <X className="size-3.5" />
                            </button>
                          </span>
                        </li>
                      ))}
                      {favorites.length > FAVORITES_PREVIEW ? (
                        <li>
                          <span className="border-border text-muted-foreground rounded-full border border-dashed px-3 py-1.5 text-sm">
                            +{favorites.length - FAVORITES_PREVIEW} autres
                          </span>
                        </li>
                      ) : null}
                    </ul>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFavoritesDialog(true)}
                      className="rounded-full"
                    >
                      <Users className="size-4" />
                      Voir tous les artistes
                    </Button>
                  </div>
                )}

                <FavoritesDialog
                  open={favoritesDialog}
                  onOpenChange={setFavoritesDialog}
                  onRemove={(channel) => void removeFavorite(channel)}
                />
              </DataCard>
            </section>

            {/* Zone 2 : maintenance — actions techniques, sans perte de donnees. */}
            <section
              aria-labelledby="data-maintenance-title"
              className="space-y-4"
            >
              <SectionHeading
                id="data-maintenance-title"
                icon={Wrench}
                label="Maintenance"
                hint="Sans perte : ces données se recalculent"
              />

              <div className="bg-surface border-border flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="bg-background/60 text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
                    <Wrench className="size-4" aria-hidden="true" />
                  </span>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">Caches dédiés</h3>
                    <p className="text-muted-foreground text-xs">
                      {overview?.cached_genres ?? 0} genres inférés ·{" "}
                      {overview?.embeddings ?? 0} embeddings. Les vider force
                      l&apos;IA à réanalyser tes écoutes.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmKind("caches")}
                  className="shrink-0 rounded-full"
                >
                  <Trash2 className="size-3.5" />
                  Vider les caches
                </Button>
              </div>
            </section>
          </div>
        </TabsContent>
      </Tabs>

      {/* Confirmation ephemere : hors du flux, donc visible quel que soit l'onglet. */}
      {notice && (
        <div
          key={notice.id}
          role="status"
          className="nb-notice bg-surface border-border pointer-events-none fixed right-6 bottom-6 z-40 rounded-full border px-4 py-2 text-xs shadow-lg"
        >
          {notice.text}
        </div>
      )}

      <IdentityDialog
        open={editIdentity}
        onOpenChange={setEditIdentity}
        firstName={identity?.first_name ?? ""}
        lastName={identity?.last_name ?? ""}
        busy={busy}
        onSubmit={saveIdentity}
      />

      {/* Retrait de la photo : confirmation, car l'action est destructive. */}
      <ConfirmDialog
        open={confirmKind === "avatar"}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        title="Retirer la photo de profil ?"
        description="Ta photo sera supprimée. Tu pourras en importer une nouvelle à tout moment."
        confirmLabel="Retirer"
        onConfirm={async () => {
          await clearAvatar();
          setConfirmKind(null);
        }}
      />

      <ConfirmDialog
        open={confirmKind === "history"}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        title="Effacer tout l'historique ?"
        description={`Les ${overview?.history ?? 0} écoutes enregistrées seront définitivement supprimées, ainsi que les statistiques associées. Tes playlists et tes notes sont conservées.`}
        confirmLabel="Tout effacer"
        onConfirm={async () => {
          await clearHistory();
          setConfirmKind(null);
        }}
      />

      <ConfirmDialog
        open={confirmKind === "caches"}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        title="Vider les caches dédiés ?"
        description="Les genres inférés et les embeddings seront supprimés ; ils se reconstruiront au fil de tes écoutes (les prochaines recommandations seront un peu plus lentes)."
        confirmLabel="Vider"
        onConfirm={async () => {
          await clearCaches();
          setConfirmKind(null);
        }}
      />
    </div>
  );
}
