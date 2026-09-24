"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  History,
  Music2,
  Pencil,
  Search,
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
import { HistoryDialog } from "@/components/profile/history-dialog";
import { IdentityDialog } from "@/components/profile/identity-dialog";
import { TasteAssistant } from "@/components/profile/taste-assistant";
import { Rating } from "@/components/layout/rating";
import { TrackCover } from "@/components/track-cover";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

// Onglets du profil : une seule section affichee a la fois, pour aerer.
const TABS = [
  { id: "identite", label: "Identité", icon: User },
  { id: "statistiques", label: "Statistiques", icon: Music2 },
  { id: "assistant", label: "Assistant", icon: Sparkles },
  { id: "ia", label: "IA", icon: BrainCircuit },
  { id: "donnees", label: "Données", icon: Database },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Comparaison tolerante : casse et accents ignores ("gazo" -> "GAZO"). */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// Listes de notes potentiellement longues : apercu tant que la section n'est pas
// depliee, rendu par paliers (le DOM ne recoit jamais toute la liste d'un coup).
const RATINGS_PREVIEW = 6;
const RATINGS_PAGE = 24;
const NOTICE_MS = 4300; // juste apres la fin de l'animation nb-notice (4200 ms)

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

/** Bloc de resume de la carte d'identite : la valeur porte le regard. */
function SummaryBlock({
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
      <Icon className="text-muted-foreground size-5" aria-hidden="true" />
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{label}</p>
    </div>
  );
}

/** Bascule « tout afficher / reduire » partagee par les listes longues. */
function MoreButton({
  total,
  open,
  onToggle,
}: {
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-expanded={open}
      className="text-muted-foreground hover:text-foreground rounded-full text-xs"
    >
      {open ? (
        <ChevronUp className="size-3.5" />
      ) : (
        <ChevronDown className="size-3.5" />
      )}
      {open ? "Réduire" : `Tout afficher (${total.toLocaleString("fr-FR")})`}
    </Button>
  );
}

/** Champ de recherche local a une liste longue (historique, notes). */
function ListFilter({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="bg-background/50 placeholder:text-muted-foreground focus-visible:ring-ring/50 h-9 w-full rounded-full pr-3 pl-9 text-sm outline-none focus-visible:ring-3 [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/** Tête de zone (onglet Données) : libellé + filet, pour séparer les groupes. */
function SectionHeading({
  id,
  icon: Icon,
  label,
  hint,
}: {
  id: string;
  icon: typeof User;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3">
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
}: {
  icon: typeof User;
  title: string;
  count?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border-border overflow-hidden rounded-xl border">
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
    <div className="bg-surface rounded-xl p-4">
      <Icon className="text-muted-foreground size-5" />
      <p className="mt-2 truncate text-xl font-bold tabular-nums" title={value}>
        {value}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">{label}</p>
    </div>
  );
}

/** Page Profil : identité, statistiques, assistant des goûts, données récoltées. */
export function ProfileView() {
  // Source unique : profil, notes, favoris et historique viennent du store, qui se
  // resynchronise sur les revisions serveur. Aucune copie locale dans la page.
  const {
    profile,
    error,
    ratings,
    favorites,
    clearRating,
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
  const [ratingsOpen, setRatingsOpen] = useState(false);
  // Nombre de notes effectivement rendues (borne le DOM, pas la donnee).
  const [ratingsLimit, setRatingsLimit] = useState(RATINGS_PAGE);
  // Filtre local des notes : au-dela de quelques dizaines d'entrees, retrouver
  // un titre precis devient le besoin principal.
  const [ratingsQuery, setRatingsQuery] = useState("");
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

  function loadMoreRatings() {
    setRatingsLimit((current) => current + RATINGS_PAGE);
  }

  const ratingsFilter = ratingsQuery.trim();
  // Le corps des notes est borne par un scroll interne des qu'il depasse
  // l'apercu.
  const ratingsScrolls = ratingsOpen || Boolean(ratingsFilter);

  // Filtre applique aux notes, independamment de ce qui est rendu.
  const filteredRatings = useMemo(() => {
    if (!ratingsFilter) return ratings;
    const needle = normalize(ratingsFilter);
    return ratings.filter((rated) =>
      normalize(`${rated.title ?? ""} ${rated.channel ?? ""}`).includes(needle),
    );
  }, [ratingsFilter, ratings]);

  // Le rendu est borne par palier : meme depliee ou filtree, la liste ne monte
  // jamais en entier dans le DOM (des milliers de notes resteraient sinon).
  const shownRatings = useMemo(() => {
    if (ratingsFilter) return filteredRatings.slice(0, ratingsLimit);
    return ratingsOpen
      ? ratings.slice(0, ratingsLimit)
      : ratings.slice(0, RATINGS_PREVIEW);
  }, [ratingsFilter, filteredRatings, ratings, ratingsLimit, ratingsOpen]);
  const ratingsTotal = ratingsFilter ? filteredRatings.length : ratings.length;
  const ratingsMore =
    (ratingsOpen || Boolean(ratingsFilter)) &&
    shownRatings.length < ratingsTotal;
  // Répartition des notes par palier : chaque palier devient une famille visuelle.
  const ratingGroups = useMemo(() => {
    const buckets = new Map<number, typeof ratings>();
    for (const rated of shownRatings) {
      const list = buckets.get(rated.rating) ?? [];
      list.push(rated);
      buckets.set(rated.rating, list);
    }
    return [...buckets.entries()].sort((a, b) => b[0] - a[0]);
  }, [shownRatings]);

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
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 py-6">
      {/* Retour à l'application : cet écran est atteint depuis la barre du haut.
          `self-start` : le conteneur est une colonne flex, sinon le bouton
          s'étirerait sur toute la largeur (libellé centré). */}
      <BackButton href="/" className="self-start" />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabId)}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        {/* Onglets centres : une seule section visible a la fois. */}
        <TabsList aria-label="Sections du profil" className="self-center">
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id}>
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="identite" className="overflow-y-auto">
          {/* Carte d'identite pleine hauteur : l'identite occupe le haut, le
              resume est ancre en bas — l'espace est compose, pas laisse vide. */}
          <section
            aria-labelledby="identity-name"
            className="bg-surface border-border flex min-h-full flex-col gap-6 rounded-xl border p-6 sm:p-8"
          >
            <div className="flex flex-1 flex-col items-center justify-center gap-6 sm:flex-row sm:items-center sm:gap-8">
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
                  variant="outline"
                  size="lg"
                  onClick={() => setEditIdentity(true)}
                  className="rounded-full"
                >
                  <Pencil className="size-4" />
                  Modifier mon identité
                </Button>
              </div>
            </div>

            <div className="border-border/60 grid grid-cols-1 gap-4 border-t pt-6 sm:grid-cols-3">
              <SummaryBlock
                icon={Music2}
                value={historyCount.toLocaleString("fr-FR")}
                label={historyCount > 1 ? "écoutes" : "écoute"}
              />
              <SummaryBlock
                icon={Star}
                value={ratings.length.toLocaleString("fr-FR")}
                label={ratings.length > 1 ? "notes" : "note"}
              />
              <SummaryBlock
                icon={Users}
                value={String(favorites.length)}
                label={
                  favorites.length > 1 ? "artistes favoris" : "artiste favori"
                }
              />
            </div>
          </section>
        </TabsContent>

        {/* Statistiques */}
        <TabsContent value="statistiques" className="overflow-y-auto">
          <div className="flex min-h-full flex-col justify-center gap-3">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
            <p className="text-muted-foreground mt-3 text-xs">
              {overview?.playlists ?? 0} playlists ·{" "}
              {overview?.cached_genres ?? 0} genres analysés
              {stats?.duree_moyenne
                ? ` · durée moyenne ${Math.round(stats.duree_moyenne)} s`
                : ""}
            </p>
          </div>
        </TabsContent>

        {/* Assistant dédié aux goûts : la conversation vit dans l'onglet. */}
        <TabsContent
          value="assistant"
          forceMount
          className="flex min-h-0 flex-col data-[state=inactive]:hidden"
        >
          <TasteAssistant active={tab === "assistant"} />
        </TabsContent>

        {/* Modèle d'IA : fournisseur, URL, modèle, clé (masquée). */}
        <TabsContent value="ia" className="overflow-y-auto">
          <div className="space-y-8">
            <AiSettingsForm />
          </div>
        </TabsContent>

        {/* Mes données */}
        <TabsContent value="donnees" className="overflow-y-auto">
          <div className="space-y-8">
            {/* Zone 1 : les donnees que l'utilisateur consulte et gere. */}
            <section aria-labelledby="data-owned-title" className="space-y-4">
              <SectionHeading
                id="data-owned-title"
                icon={Database}
                label="Tes données"
                hint="Ce que le moteur a appris de toi"
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
                {ratings.length > RATINGS_PREVIEW && (
                  <div className="mb-4">
                    <ListFilter
                      value={ratingsQuery}
                      onChange={setRatingsQuery}
                      placeholder="Rechercher un titre noté…"
                      label="Rechercher dans les titres notés"
                    />
                    {ratingsFilter && (
                      <p
                        role="status"
                        className="text-muted-foreground mt-2 text-xs"
                      >
                        {ratingsTotal.toLocaleString("fr-FR")} résultat
                        {ratingsTotal > 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                )}

                {ratings.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucune note pour l&apos;instant. Note un titre depuis la
                    recherche ou la barre de lecture pour le retrouver ici.
                  </p>
                ) : ratingGroups.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucun titre ne correspond à « {ratingsFilter} ».
                  </p>
                ) : (
                  <div
                    className={cn(
                      "space-y-5",
                      ratingsScrolls && "max-h-[26rem] overflow-y-auto pr-1",
                    )}
                  >
                    {ratingGroups.map(([value, list]) => (
                      <div key={value}>
                        <div className="mb-2 flex items-baseline gap-2">
                          <h4 className="text-sm font-medium">
                            {RATING_LABELS[value] ?? "Notés"}
                          </h4>
                          <span
                            className="text-primary flex items-center gap-0.5"
                            aria-hidden="true"
                          >
                            {Array.from({ length: value }, (_, i) => (
                              <Star key={i} className="size-3 fill-current" />
                            ))}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {list.length} titre{list.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {list.map((rated) => (
                            <li
                              key={rated.video_id}
                              className="group/row bg-background/40 hover:bg-surface-hover flex items-center gap-3 rounded-lg p-2 transition-colors"
                            >
                              <TrackCover
                                videoId={rated.video_id}
                                title={rated.title}
                                sizes={coverSizes(48)}
                                className="size-12 shrink-0"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">
                                  {rated.title}
                                </span>
                                <span className="text-muted-foreground block truncate text-xs">
                                  {rated.channel}
                                </span>
                              </span>
                              {/* Le palier porte déjà les étoiles : le sélecteur ne
                                  s'affiche qu'au survol/focus de la ligne (on peut
                                  toujours corriger la note), et reste visible sur
                                  les écrans tactiles, où le survol n'existe pas. */}
                              <Rating
                                videoId={rated.video_id}
                                title={rated.title}
                                channel={rated.channel}
                                className="shrink-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
                              />
                              <button
                                type="button"
                                aria-label={`Retirer la note de ${rated.title}`}
                                onClick={() => void clearRating(rated.video_id)}
                                className="text-muted-foreground hover:text-destructive shrink-0 rounded-full p-1"
                              >
                                <X className="size-4" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {ratings.length > RATINGS_PREVIEW && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {!ratingsFilter && (
                      <MoreButton
                        total={ratings.length}
                        open={ratingsOpen}
                        onToggle={() => setRatingsOpen((value) => !value)}
                      />
                    )}
                    {ratingsMore && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={loadMoreRatings}
                        className="text-muted-foreground hover:text-foreground rounded-full text-xs"
                      >
                        Charger plus (
                        {Math.min(
                          RATINGS_PAGE,
                          ratingsTotal - shownRatings.length,
                        ).toLocaleString("fr-FR")}
                        )
                      </Button>
                    )}
                  </div>
                )}
              </DataCard>

              <DataCard
                icon={Users}
                title="Artistes favoris"
                count={String(favorites.length)}
              >
                {favorites.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Aucun favori — une note ★ ≥ 4 ajoute l&apos;artiste
                    automatiquement.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {favorites.map((channel) => (
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
                  </ul>
                )}
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
