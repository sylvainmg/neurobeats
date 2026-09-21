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
import { IdentityDialog } from "@/components/profile/identity-dialog";
import { TasteAssistant } from "@/components/profile/taste-assistant";
import { Rating } from "@/components/layout/rating";
import { TrackCover } from "@/components/track-cover";
import { api, type HistoryEntry } from "@/lib/api";
import { useStore } from "@/lib/store";
import { coverSizes } from "@/lib/track";
import { cn } from "cn";

// Onglets du profil : une seule section affichee a la fois, pour aerer.
const TABS = [
  { id: "identite", label: "Identité", icon: User },
  { id: "statistiques", label: "Statistiques", icon: Music2 },
  { id: "assistant", label: "Assistant", icon: Sparkles },
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

// Listes potentiellement longues (milliers d'entrées) : on n'affiche qu'un
// apercu tant que la section n'est pas depliee, et le corps deplie reste borne
// par un scroll interne — la page garde une hauteur maitrisee.
const HISTORY_PREVIEW = 12;
const RATINGS_PREVIEW = 6;
const HISTORY_PAGE = 60;
const HISTORY_MAX = 500; // plafond de l'API /api/profile/history
// Palier de rendu des notes : le DOM ne recoit jamais toute la liste d'un coup
// (les notes sont chargees en entier pour l'app, mais rendues par tranches).
const RATINGS_PAGE = 24;
const NOTICE_MS = 4300; // juste apres la fin de l'animation nb-notice (4200 ms)

/** Heure de l'écoute, affichée au survol d'une vignette d'historique. */
function formatHour(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface HistoryGroup {
  key: string;
  label: string;
  items: HistoryEntry[];
}

/**
 * Regroupe les écoutes par journée (du plus récent au plus ancien).
 *
 * Un historique plat ne dit rien : la journée donne le rythme (aujourd'hui, hier,
 * puis les dates), et chaque groupe se parcourt en vignettes.
 */
function groupByDay(entries: HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  const index = new Map<string, HistoryGroup>();
  const today = new Date();
  for (const entry of entries) {
    const date = entry.timestamp ? new Date(entry.timestamp) : null;
    const valid = date !== null && !Number.isNaN(date.getTime());
    const key = valid ? (date as Date).toDateString() : "inconnue";
    let group = index.get(key);
    if (!group) {
      const startOfDay = (value: Date) =>
        new Date(
          value.getFullYear(),
          value.getMonth(),
          value.getDate(),
        ).getTime();
      const diff = valid
        ? (startOfDay(today) - startOfDay(date as Date)) / 86_400_000
        : Number.POSITIVE_INFINITY;
      group = {
        key,
        label: !valid
          ? "Date inconnue"
          : diff === 0
            ? "Aujourd'hui"
            : diff === 1
              ? "Hier"
              : (date as Date).toLocaleDateString("fr-FR", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }),
        items: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(entry);
  }
  return groups;
}

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
    history,
    historyLimit,
    clearRating,
    ensureHistory,
    loadMoreHistory: fetchMoreHistory,
    resetHistory,
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [ratingsOpen, setRatingsOpen] = useState(false);
  // Nombre de notes effectivement rendues (borne le DOM, pas la donnee).
  const [ratingsLimit, setRatingsLimit] = useState(RATINGS_PAGE);
  // Filtres locaux : au-dela de quelques dizaines d'entrees, retrouver un titre
  // precis devient le besoin principal.
  const [historyQuery, setHistoryQuery] = useState("");
  const [ratingsQuery, setRatingsQuery] = useState("");
  // `id` force le redemarrage de l'animation quand un nouveau message remplace
  // l'ancien.
  const noticeSeq = useRef(0);
  const [tab, setTab] = useState<TabId>("identite");

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

  // L'historique n'est charge qu'a l'ouverture de l'onglet Donnees : inutile de
  // payer le cout d'un long historique tant qu'il n'est pas regarde.
  useEffect(() => {
    if (tab !== "donnees") return;
    let active = true;
    void (async () => {
      await ensureHistory();
      if (!active) return;
    })();
    return () => {
      active = false;
    };
  }, [tab, ensureHistory]);

  function loadMoreHistory() {
    void fetchMoreHistory();
  }

  function loadMoreRatings() {
    setRatingsLimit((current) => current + RATINGS_PAGE);
  }

  const historyFilter = historyQuery.trim();
  const ratingsFilter = ratingsQuery.trim();
  // Le corps est borne par un scroll interne des qu'il depasse l'apercu.
  const historyScrolls = historyOpen || Boolean(historyFilter);
  const ratingsScrolls = ratingsOpen || Boolean(ratingsFilter);

  // Priorite d'affichage : un filtre actif montre tous ses resultats ; sinon un
  // apercu suffit tant que la section n'est pas depliee.
  const shownHistory = useMemo(() => {
    if (historyFilter) {
      const needle = normalize(historyFilter);
      return history.filter((entry) =>
        normalize(`${entry.title ?? ""} ${entry.channel ?? ""}`).includes(
          needle,
        ),
      );
    }
    return historyOpen ? history : history.slice(0, HISTORY_PREVIEW);
  }, [historyFilter, history, historyOpen]);
  const groups = useMemo(() => groupByDay(shownHistory), [shownHistory]);

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
    setHistoryOpen(false);
    await resetHistory();
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
                    disabled={history.length === 0}
                    onClick={() => setConfirmKind("history")}
                    className="text-muted-foreground hover:text-destructive rounded-full text-xs"
                  >
                    <Trash2 className="size-3.5" />
                    Tout effacer
                  </Button>
                }
              >
                {history.length > HISTORY_PREVIEW && (
                  <div className="mb-4">
                    <ListFilter
                      value={historyQuery}
                      onChange={setHistoryQuery}
                      placeholder="Rechercher un titre ou un artiste…"
                      label="Rechercher dans l'historique"
                    />
                    {historyFilter && (
                      <p
                        role="status"
                        className="text-muted-foreground mt-2 text-xs"
                      >
                        {shownHistory.length.toLocaleString("fr-FR")} résultat
                        {shownHistory.length > 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                )}

                {groups.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {historyFilter
                      ? `Aucune écoute ne correspond à « ${historyFilter} ».`
                      : "Aucune écoute enregistrée. Lance un titre depuis la recherche ou l'accueil."}
                  </p>
                ) : (
                  <div
                    className={cn(
                      "space-y-5",
                      historyScrolls && "max-h-[26rem] overflow-y-auto pr-1",
                    )}
                  >
                    {groups.map((group) => (
                      <div key={group.key}>
                        <div className="mb-2 flex items-baseline gap-2">
                          <h4 className="text-sm font-medium capitalize">
                            {group.label}
                          </h4>
                          <span className="text-muted-foreground text-xs">
                            {group.items.length} écoute
                            {group.items.length > 1 ? "s" : ""}
                          </span>
                        </div>
                        <ul className="flex flex-wrap gap-2">
                          {group.items.map((entry) => (
                            <li key={entry.id} className="group relative">
                              <TrackCover
                                videoId={entry.video_id}
                                title={entry.title}
                                sizes={coverSizes(64)}
                                rounded="rounded-lg"
                                className="size-16"
                              />
                              {/* Au survol : l'heure de l'écoute, et de quoi la retirer. */}
                              <span className="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 rounded-b-lg bg-black/65 py-0.5 text-center text-[10px] tabular-nums opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                                {formatHour(entry.timestamp)}
                              </span>
                              <button
                                type="button"
                                aria-label={`Supprimer l'écoute de ${entry.title || entry.video_id}`}
                                onClick={() => void removeListen(entry.id)}
                                className="bg-background/90 text-muted-foreground hover:text-destructive absolute -top-1.5 -right-1.5 rounded-full p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              >
                                <X className="size-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {!historyFilter && history.length > HISTORY_PREVIEW && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <MoreButton
                      total={history.length}
                      open={historyOpen}
                      onToggle={() => setHistoryOpen((value) => !value)}
                    />
                    {historyOpen &&
                      history.length < historyCount &&
                      historyLimit < HISTORY_MAX && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={loadMoreHistory}
                          className="text-muted-foreground hover:text-foreground rounded-full text-xs"
                        >
                          Charger plus (
                          {Math.min(
                            HISTORY_PAGE,
                            historyCount - history.length,
                          ).toLocaleString("fr-FR")}
                          )
                        </Button>
                      )}
                  </div>
                )}
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
