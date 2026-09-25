/**
 * Client HTTP du backend NeuroBeats (FastAPI).
 *
 * Le backend active CORS : le front l'appelle directement depuis le browser.
 * Toutes les reponses passent par l'enveloppe {status, data, error}.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Erreur applicative remontée par l'API ou le réseau. */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Réponse normalisée du backend. */
export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string | null;
}

/** Titre YouTube renvoyé par la recherche. */
export interface Track {
  video_id: string;
  title: string;
  channel: string;
  duration?: number | null;
  genre?: string;
}

/** Mode de répétition du flux (GET /api/now, POST /api/stream/repeat). */
export type RepeatMode = "off" | "all" | "one";

/** État de lecture courant (GET /api/now). */
export interface NowPlayingState {
  playing: boolean;
  paused: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  video_id: string;
  title: string;
  channel: string;
  position: number | null;
  duration: number | null;
}

/** Ligne de paroles : horodatée (synchro) ou non (texte → défilement estimé). */
export interface LyricLine {
  /** Instant de début en secondes, `null` pour les paroles non synchronisées. */
  time: number | null;
  text: string;
}

/** Réponse de GET /api/lyrics. */
export interface LyricsPayload {
  found: boolean;
  /** `true` = lignes horodatées (karaoké) ; `false` = texte brut. */
  synced: boolean;
  source: "lrclib" | "genius" | null;
  instrumental: boolean;
  title: string;
  artist: string;
  lines: LyricLine[];
  /** Détail — présent uniquement quand `found:false` et `retryable:true`. */
  message: string | null;
  /** Panne réseau transitoire : l'UI propose « Réessayer ». */
  retryable?: boolean;
}

/** Titre affiché sur l'accueil (bloc « Reprendre » ou recommandation). */
export interface HomeTrack {
  video_id: string;
  title: string;
  channel: string;
  genre?: string;
}

/** Contenu de la page d'accueil (GET /api/home), assemblé côté serveur. */
export interface HomeContent {
  ready: boolean;
  building?: boolean;
  headline: string;
  intro: string;
  genre?: string;
  resume: HomeTrack | null;
  tracks: HomeTrack[];
}

/** Titre de la file pré-calculée (GET /api/stream/queue). */
export interface QueueTrack {
  video_id: string;
  title: string;
  channel: string;
  genre: string;
}

/** Timeline linéaire de lecture (GET /api/stream/queue). */
export interface QueueState {
  mood: string;
  force_genre: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  remaining: number;
  position: number;
  /** Séquence complète : titres joués + courant + titres à venir. */
  tracks: QueueTrack[];
  /** Index du titre en lecture dans `tracks` (-1 si vide). */
  current_index: number;
  filling: boolean;
}

/** Titre d'une playlist. */
export interface PlaylistTrack {
  video_id: string;
  title: string;
  channel: string;
}

/** Playlist complète (GET /api/playlists/{id}). */
export interface Playlist {
  id: string;
  name: string;
  mood: string;
  songs: PlaylistTrack[];
  created: string;
  updated: string;
}

/** Session de transfert vers le téléphone (POST /api/transfer). */
export interface TransferTicket {
  session: string;
  /** Le lien encodé dans le code QR (session + jeton, réseau local). */
  url: string;
  expire_dans: number;
  playlist: string;
  titres: number;
  /** Titres déjà en mémoire côté bureau : transférés sans repasser par YouTube. */
  prets: number;
  a_preparer: number;
}

/** Résumé de playlist (GET /api/playlists). */
export interface PlaylistSummary {
  id: string;
  name: string;
  mood: string;
  count: number;
  /** video_id du premier titre (vignette), vide si playlist vide. */
  cover: string;
  created: string;
  updated: string;
  /** Présent seulement si `?video_id=` a été fourni : la playlist contient ce titre. */
  contains?: boolean;
}

/**
 * Ce que le poste garde sur son disque pour une playlist.
 *
 * « Sur cet appareil » est la seule garantie d'écoute hors ligne : un titre connu
 * par son `video_id` mais sans fichier sur le disque dépend encore du réseau.
 */
export interface PlaylistLocalTrack {
  video_id: string;
  /** `pret` = fichier sur le disque ; `absent` = il reste à télécharger. */
  etat: "pret" | "absent";
  taille: number;
  duree: number;
  /** Format servi par le cache local (« m4a » ou « webm »). */
  format: string;
}

export interface PlaylistLocal {
  playlist: string;
  playlist_id: string;
  /** Nombre de titres de la playlist. */
  titres: number;
  /** Titres dont le fichier est sur le disque. */
  pret: number;
  /** Titres à télécharger. */
  manquant: number;
  /** Poids des fichiers présents, en octets. */
  octets: number;
  details: PlaylistLocalTrack[];
}

/** Titre de la page Découvrir. */
export interface DiscoverTrack {
  video_id: string;
  title: string;
  channel: string;
  genre?: string;
}

/** Titre « Redécouvre » (historique délaissé). */
export interface RediscoverTrack extends DiscoverTrack {
  last_played?: string;
}

/** Groupe « Artistes favoris ». */
export interface ArtistGroup {
  channel: string;
  plays: number;
  tracks: DiscoverTrack[];
}

/** Tuile de genre (métadonnées ; les titres arrivent à la demande). */
export interface GenreTile {
  genre: string;
  label: string;
  ready: boolean;
  building: boolean;
}

/** Contenu de Découvrir (GET /api/discover), construit en arrière-plan. */
export interface DiscoverPayload {
  ready: boolean;
  building: boolean;
  generated_at: number;
  mix: { ready: boolean; headline: string; intro: string; genre: string; tracks: DiscoverTrack[] };
  rediscover: { ready: boolean; tracks: RediscoverTrack[] };
  artists: { ready: boolean; items: ArtistGroup[] };
  genres: { ready: boolean; items: GenreTile[] };
}

/** Tuile de genre développée (GET /api/discover/genre/{genre}). */
export interface GenreSection {
  genre: string;
  label: string;
  ready: boolean;
  building: boolean;
  tracks: DiscoverTrack[];
}

/** Identité de l'utilisateur (GET /api/profile). */
export interface ProfileIdentity {
  first_name: string;
  last_name: string;
  display_name: string;
  /** Photo en data URL ("" si aucune). */
  avatar: string;
  updated: string;
}

/** Statistiques d'écoute (GET /api/stats). */
export interface ProfileStats {
  plays_total: number;
  genre_top?: { genre: string; plays: number } | null;
  artiste_top?: { channel: string; plays: number } | null;
  heure_pref?: { slot: string; plays: number } | null;
  skip_count: number;
  skip_ratio: number;
  duree_moyenne?: number | null;
}

/** Compteurs des données récoltées. */
export interface ProfileOverview {
  history: number;
  ratings: number;
  favorites: number;
  playlists: number;
  cached_genres: number;
  embeddings: number;
}

/** Profil complet (identité + stats + compteurs). */
export interface UserProfile {
  identity: ProfileIdentity;
  stats: ProfileStats;
  overview: ProfileOverview;
}

/** Une écoute de l'historique (suppression unitaire par `id`). */
export interface HistoryEntry {
  id: number;
  video_id: string;
  title: string;
  channel: string;
  timestamp: string;
  duration?: number | null;
  genre?: string;
  skip?: number;
}

/** Titre noté (★). */
export interface RatedTrack {
  video_id: string;
  rating: number;
  title: string;
  channel: string;
}

/** Point de départ de recherche, libellé par l'IA (jamais une liste figée). */
export interface SearchSuggestion {
  label: string;
  query: string;
}

/** Le choix IA : un enregistrement unique (source de vérité du backend). */
export interface AiSelection {
  kind: "ollama" | "lmstudio" | "openai" | "anthropic" | "embedded";
  /** Id du modèle local, présent uniquement quand `kind === "embedded"`. */
  model?: string;
}

/** Modèle local téléchargé, proposé comme choix au même titre qu'un externe. */
export interface AiLocalModel {
  model_id: string;
  name: string;
  size_bytes: number;
}

/** État du moteur local : lisible pendant un chargement. */
export interface AiEmbeddedStatus {
  state: "idle" | "loading" | "ready" | "error";
  /** Le modèle choisi est encore en téléchargement : rien à charger encore. */
  waiting_for_download?: boolean;
  model_id?: string;
  pid?: number;
  port?: number;
  since?: string;
  error?: string;
}

/** Réglages du modèle IA (GET/PUT /api/profile/ai). Cle API toujours masquée. */
export interface AiSettings {
  /** Dérivé de `selection` par le backend : jamais une seconde source. */
  provider: AiSelection["kind"];
  /** Le choix, tel que persisté par le backend. */
  selection: AiSelection;
  /** Modèles locaux téléchargés, proposés comme choix. */
  models: AiLocalModel[];
  /** État du moteur local (progression du chargement). */
  engine: AiEmbeddedStatus;
  configured: boolean;
  label: string;
  ollama: { host?: string; model?: string };
  lmstudio: { base_url?: string; model?: string };
  openai: { base_url?: string; model?: string; api_key_masked?: string };
  anthropic: { base_url?: string; model?: string; api_key_masked?: string };
}

/** Corps de la mise à jour : `api_key` absent (undefined) = conservée, "" = effacée. */
export interface AiSettingsPatch {
  /** Le choix : l'enregistrer propage la sélection partout. */
  selection?: AiSelection;
  provider?: AiSelection["kind"];
  ollama?: Partial<AiSettings["ollama"]>;
  lmstudio?: Partial<AiSettings["lmstudio"]>;
  openai?: Partial<AiSettings["openai"]> & { api_key?: string };
  anthropic?: Partial<AiSettings["anthropic"]> & { api_key?: string };
}

/** Réponse de POST /api/profile/ai/test. */
export interface AiTestResult {
  ok: boolean;
  latency_ms?: number;
  provider?: string;
  model?: string;
  error?: string;
}

/**
 * Wrapper fetch vers le backend.
 *
 * @param path Chemin de l'endpoint (ex. "/api/search").
 * @param init Options fetch (method, body JSON, signal...).
 * @returns Le champ `data` typé, ou lève une ApiError.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (err) {
    // Requête annulée volontairement (choix plus récent de l'utilisateur) : on
    // propage l'AbortError tel quel pour que l'appelant la distingue d'une panne.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`Backend injoignable (${API_URL})`, 0);
  }

  let body: ApiResponse<T> | null = null;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    body = null;
  }

  if (!response.ok || body?.status === "error") {
    throw new ApiError(
      body?.error ?? `Erreur ${response.status}`,
      response.status,
    );
  }

  return body?.data as T;
}

function post<T>(path: string, body?: unknown, init?: RequestInit) {
  return apiFetch<T>(path, {
    method: "POST",
    ...init,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  health: () => apiFetch("/api/health"),

  // Recherche
  search: (q: string, limit = 10, signal?: AbortSignal) =>
    apiFetch<Track[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
      signal,
    }),
  searchSuggestions: () =>
    apiFetch<{ suggestions: SearchSuggestion[]; building: boolean }>(
      "/api/search/suggestions",
    ),
  refreshSearchSuggestions: () =>
    post<{ status: string }>("/api/search/suggestions/refresh"),

  // Lecture
  now: () => apiFetch<NowPlayingState>("/api/now"),
  play: (video_id: string, signal?: AbortSignal) =>
    post<NowPlayingState>("/api/play", { video_id }, { signal }),
  playNow: (query: string) => post<NowPlayingState>("/api/play_now", { query }),
  playChoice: (index: number) => post("/api/play_choice", { index }),
  stop: () => post<{ status: string }>("/api/stop"),
  pause: () => post<{ status: string; paused: boolean }>("/api/pause"),
  seek: (position: number) =>
    post<{ status: string; position: number }>("/api/seek", { position }),
  volume: (volume: number) =>
    post<{ status: string; volume: number }>("/api/volume", { volume }),

  // Paroles (GET /api/lyrics) — titre/chaine/duree sont des replis : le serveur
  // résout ses propres métadonnées, ces params ne servent qu'aux titres pas
  // encore joués.
  lyrics: (
    videoId: string,
    title: string,
    channel: string,
    duration?: number | null,
  ) => {
    const params = new URLSearchParams({ video_id: videoId });
    if (title) params.set("title", title);
    if (channel) params.set("channel", channel);
    if (duration && duration > 0) params.set("duration", String(duration));
    return apiFetch<LyricsPayload>(`/api/lyrics?${params.toString()}`);
  },

  // File / streaming
  queue: () => apiFetch<QueueState>("/api/stream/queue"),
  queueRemove: (index: number) =>
    post<{ status?: string; video_id?: string; title?: string; queue_remaining?: number }>(
      "/api/stream/queue/remove",
      { index },
    ),
  streamSkip: () =>
    post<{ status?: string; queue_remaining?: number; title?: string }>(
      "/api/stream/skip",
    ),
  streamPrevious: () => post<NowPlayingState>("/api/stream/previous"),
  streamJump: (index: number) =>
    post<NowPlayingState>("/api/stream/jump", { index }),
  streamStop: () => post<{ status: string }>("/api/stream/stop"),
  setShuffle: (shuffle: boolean) =>
    post<{ shuffle: boolean }>("/api/stream/shuffle", { shuffle }),
  setRepeat: (mode: RepeatMode) =>
    post<{ repeat: RepeatMode }>("/api/stream/repeat", { mode }),

  // Accueil (recos + habillage rédigé par le LLM, servi depuis un cache serveur)
  home: () => apiFetch<HomeContent>("/api/home"),

  // Découvrir (sections construites en arrière-plan ; le client repasse si !ready)
  discover: () => apiFetch<DiscoverPayload>("/api/discover"),
  discoverGenre: (genre: string, force = false) =>
    apiFetch<GenreSection>(
      `/api/discover/genre/${encodeURIComponent(genre)}${force ? "?force=1" : ""}`,
    ),
  refreshDiscover: () =>
    post<{ status: string }>("/api/discover/refresh"),

  // Flux
  streamStart: (mood: string, forceGenre = true) =>
    post<{ status: string; mood: string }>("/api/stream/start", {
      mood,
      force_genre: forceGenre,
    }),

  // Profil (identité, statistiques, données récoltées)
  getProfile: () => apiFetch<UserProfile>("/api/profile"),
  updateProfile: (body: { first_name?: string; last_name?: string }) =>
    apiFetch<{ status: string; identity: ProfileIdentity }>("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  setAvatar: (avatar: string) =>
    apiFetch<{ status: string; identity: ProfileIdentity }>("/api/profile/avatar", {
      method: "PUT",
      body: JSON.stringify({ avatar }),
    }),
  clearAvatar: () =>
    apiFetch<{ status: string; identity: ProfileIdentity }>("/api/profile/avatar", {
      method: "DELETE",
    }),
  profileData: () => apiFetch<ProfileOverview>("/api/profile/data"),
  profileHistory: (limit = 100, offset = 0) =>
    apiFetch<{ entries: HistoryEntry[] }>(
      `/api/profile/history?limit=${limit}&offset=${offset}`,
    ),
  deleteHistoryEntry: (entryId: number) =>
    apiFetch<{ status: string }>(`/api/profile/history/${entryId}`, { method: "DELETE" }),
  clearHistory: () =>
    apiFetch<{ status: string; removed: number }>("/api/profile/history?confirm=1", {
      method: "DELETE",
    }),
  listPreferences: () => apiFetch<{ ratings: RatedTrack[] }>("/api/profile/preferences"),
  deletePreference: (videoId: string) =>
    apiFetch<{ status: string }>(
      `/api/profile/preferences/${encodeURIComponent(videoId)}`,
      { method: "DELETE" },
    ),
  listFavorites: () => apiFetch<{ favorites: string[] }>("/api/profile/favorites"),
  addFavorite: (channel: string) =>
    apiFetch<{ status: string; favorites: string[] }>(
      `/api/profile/favorites/${encodeURIComponent(channel)}`,
      { method: "POST" },
    ),
  removeFavorite: (channel: string) =>
    apiFetch<{ status: string; favorites: string[] }>(
      `/api/profile/favorites/${encodeURIComponent(channel)}`,
      { method: "DELETE" },
    ),
  clearCaches: () =>
    post<{ status: string; removed: Record<string, number> }>("/api/profile/caches/clear"),

  // Modèle IA (onglet « IA » du profil) — clés API masquées par le backend.
  getAiSettings: () => apiFetch<AiSettings>("/api/profile/ai"),
  saveAiSettings: (body: AiSettingsPatch) =>
    apiFetch<AiSettings>("/api/profile/ai", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  /** État du moteur local seul : poll léger pendant un chargement de modèle. */
  getAiEmbedded: () => apiFetch<AiEmbeddedStatus>("/api/profile/ai/embedded"),
  /**
   * Vérifie que la config répond. Le corps optionnel porte les valeurs en cours
   * d'édition (formulaire non sauvé) : le backend les teste sans rien persister.
   * On normalise toujours en AiTestResult (200+{ok:false} ou erreur réseau).
   */
  testAiConnection: async (body?: AiSettingsPatch): Promise<AiTestResult> => {
    try {
      return await apiFetch<AiTestResult>("/api/profile/ai/test", {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        return { ok: false, provider: undefined, error: err.message };
      }
      return { ok: false, error: "Backend injoignable." };
    }
  },

  // Notes ★
  setPreference: (video_id: string, rating: number) =>
    post<{ status: string; video_id: string; rating: number }>("/api/preference", {
      video_id,
      rating,
    }),

  // Divers
  stats: () => apiFetch("/api/stats"),
  recommend: (mood = "", forceGenre = false) =>
    apiFetch(
      `/api/recommend?mood=${encodeURIComponent(mood)}&force_genre=${forceGenre}`,
    ),

  // Bibliothèque (playlists)
  listPlaylists: (videoId?: string) =>
    apiFetch<{ playlists: PlaylistSummary[] }>(
      `/api/playlists${videoId ? `?video_id=${encodeURIComponent(videoId)}` : ""}`,
    ),
  getPlaylist: (id: string) =>
    apiFetch<{ playlist: Playlist }>(`/api/playlists/${encodeURIComponent(id)}`),
  createPlaylist: (body: {
    name: string;
    mood?: string;
    count?: number;
    /** Titres explicites : la playlist contiendra exactement ceux-ci. */
    video_ids?: string[];
  }) => post<{ status: string; playlist: Playlist }>("/api/playlists", body),
  renamePlaylist: (id: string, name: string) =>
    apiFetch<{ status: string; playlist: Playlist }>(
      `/api/playlists/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    ),
  deletePlaylist: (id: string) =>
    apiFetch<{ status: string }>(`/api/playlists/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  addPlaylistTrack: (id: string, videoId: string) =>
    post<{ status: string; playlist: Playlist }>(
      `/api/playlists/${encodeURIComponent(id)}/tracks`,
      { video_id: videoId },
    ),
  /**
   * Ouvre une session de transfert et rend le code à afficher.
   *
   * Réservé au bureau : le backend refuse la création depuis une autre machine,
   * le code étant une clé d'accès au réseau local.
   */
  mintTransfer: (playlistId: string) =>
    post<TransferTicket>("/api/transfer", { playlist_id: playlistId }),
  removePlaylistTrack: (id: string, videoId: string) =>
    apiFetch<{ status: string; playlist: Playlist }>(
      `/api/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(videoId)}`,
      { method: "DELETE" },
    ),
  playPlaylist: (id: string, start = 0) =>
    post<{ status: string; playlist: Playlist; position: number; count: number }>(
      `/api/playlists/${id}/play`,
      { start },
    ),

  // Téléchargement local (bureau) : ce que le poste garde sur son disque.
  /** État de téléchargement de chaque titre — lecture seule, ne lance rien. */
  playlistLocal: (id: string) =>
    apiFetch<PlaylistLocal>(`/api/playlists/${id}/local`),
  /** Demande les titres manquants ; déjà téléchargés ne sont pas relancés. */
  downloadPlaylistLocal: (id: string, videoIds: string[] = []) =>
    post<{ status: string; playlist: string; demandes: number; deja_pret: number; echecs: number }>(
      `/api/playlists/${id}/local/telecharger`,
      { video_ids: videoIds },
    ),
};

// ------------------------------------------------------------------ Chat (SSE)

/** Message du fil envoyé au backend (rôles user/assistant/tool + tool_calls). */
export interface ChatWireMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

/** Portée du chat : assistant musical global, ou assistant dédié aux goûts. */
export type ChatScope = "global" | "profile";

/** Événement du flux `POST /api/chat/stream`. */
export type ChatEvent =
  | { type: "token"; content: string }
  | {
      type: "tool_start" | "tool_end";
      name: string;
      label?: string;
      ok?: boolean;
      summary?: string;
    }
  | {
      type: "done";
      messages: ChatWireMessage[];
      tool_calls: { name: string; ok: boolean }[];
    }
  | { type: "error"; error: string };

/**
 * Consomme le flux SSE du chat (`EventSource` ne permet pas de POST : on lit
 * directement le corps de la réponse via `fetch` + `ReadableStream`).
 *
 * @param messages Historique complet envoyé au backend (tronqué côté serveur).
 * @param onEvent  Appelé pour chaque événement décodé.
 * @param signal   Permet d'annuler le flux (bouton Stop / démontage).
 * @param scope    "global" (assistant musical) ou "profile" (assistant des goûts).
 */
export async function chatStream(
  messages: ChatWireMessage[],
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  scope: ChatScope = "global",
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/chat/stream`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, scope }),
    });
  } catch {
    if (signal?.aborted) return;
    throw new ApiError("Backend injoignable.", 0);
  }

  if (!response.ok || !response.body) {
    throw new ApiError(`Assistant indisponible (${response.status})`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as ChatEvent);
        } catch {
          // frame illisible : on ignore
        }
      }
    }
  }
}

