"use client";

import { useSyncExternalStore } from "react";

import type { ChatWireMessage } from "@/lib/api";

/**
 * Historique de conversation persisté côté navigateur (le serveur est sans état
 * et tronque de toute façon avant d'envoyer au modèle).
 *
 * Le module expose une **fabrique** : chaque portée (assistant musical global,
 * assistant des goûts sur le Profil) a son propre store et ses propres
 * conversations. L'état est un *external store* (`useSyncExternalStore`) :
 * lecture stable au rendu, synchro entre onglets via l'événement `storage`.
 */
const MAX_SESSIONS = 20;
const LOCAL_MAX_MESSAGES = 100;
const LOCAL_MAX_BYTES = 64_000;
const STORE_MAX_BYTES = 256_000;

/**
 * Plafond par message (question comme réponse), aligné sur la garde-fou serveur
 * (`MAX_CHARS_PER_MESSAGE`). Couche de sécurité, pas une limite de confort.
 */
export const MAX_MESSAGE_CHARS = 2000;

/** Message affiché dans le fil (l'utilisateur et l'assistant parlent). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Une conversation persistée. */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatWireMessage[];
  updatedAt: number;
}

/** Racine persistée : la conversation active + les conversations passées. */
export interface ChatStore {
  version: 2;
  activeId: string;
  sessions: ChatSession[];
}

/** Libellés français des outils du moteur (repli si le backend n'en fournit pas). */
export const TOOL_LABELS: Record<string, string> = {
  search_music: "Recherche",
  play_now: "Lecture",
  play_music: "Lecture",
  play_choice: "Lecture",
  stop_music: "Arrêt",
  create_playlist: "Création de playlist",
  load_playlist: "Chargement de playlist",
  playlist_next: "Playlist",
  list_playlists: "Bibliothèque",
  rename_playlist: "Renommage",
  delete_playlist: "Suppression",
  add_track_to_playlist: "Ajout à une playlist",
  remove_track_from_playlist: "Retrait d'une playlist",
  start_streaming: "Flux infini",
  stop_streaming: "Arrêt du flux",
  skip_streaming: "Titre suivant",
  get_recommendation: "Recommandation",
  get_user_stats: "Statistiques",
  store_preference: "Préférence",
  get_taste_summary: "Résumé des goûts",
  list_rated: "Titres notés",
  remove_rating: "Retrait d'une note",
  list_favorites: "Artistes favoris",
  add_favorite: "Ajout aux favoris",
  remove_favorite: "Retrait des favoris",
  delete_last_listen: "Suppression d'une écoute",
  clear_history: "Effacement de l'historique",
  update_profile_name: "Mise à jour du profil",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** Filtre le fil « wire » pour l'affichage (user/assistant avec du texte). */
export function visibleMessages(wire: ChatWireMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of wire) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!(message.content ?? "").trim()) continue;
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

// --- Fabrique de store -----------------------------------------------------

const EMPTY_STORE: ChatStore = { version: 2, activeId: "", sessions: [] };

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function asMessages(value: unknown): ChatWireMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is ChatWireMessage => Boolean(m) && typeof (m as ChatWireMessage).role === "string",
  );
}

/** Titre d'une conversation : premier message utilisateur, tronqué. */
function deriveTitle(messages: ChatWireMessage[]): string {
  const first = messages.find((m) => m.role === "user" && (m.content ?? "").trim());
  if (!first) return "Nouvelle conversation";
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/** Borne les messages d'une conversation (nombre puis volume). */
function boundMessages(messages: ChatWireMessage[]): ChatWireMessage[] {
  let bounded = messages.slice(-LOCAL_MAX_MESSAGES);
  while (bounded.length > 2 && JSON.stringify(bounded).length > LOCAL_MAX_BYTES) {
    bounded = bounded.slice(Math.max(1, Math.floor(bounded.length / 4)));
  }
  return bounded;
}

/** Borne la liste des conversations (nombre puis volume total). */
function boundSessions(sessions: ChatSession[]): ChatSession[] {
  let bounded = sessions.slice(0, MAX_SESSIONS);
  while (bounded.length > 1 && JSON.stringify(bounded).length > STORE_MAX_BYTES) {
    bounded = bounded.slice(0, bounded.length - 1); // retire les plus anciennes
  }
  return bounded;
}

export interface ChatStoreApi {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => ChatStore;
  getServerSnapshot: () => ChatStore;
  activeMessages: (store: ChatStore) => ChatWireMessage[];
  pastSessions: (store: ChatStore) => ChatSession[];
  writeChat: (messages: ChatWireMessage[]) => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  startNewConversation: () => void;
}

/**
 * Crée un store de conversations adossé à `storageKey`.
 *
 * `legacyKey` permet de reprendre l'ancien format mono-conversation (v1).
 */
export function createChatStore(storageKey: string, legacyKey?: string): ChatStoreApi {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cachedStore: ChatStore = EMPTY_STORE;

  function readRaw(): string | null {
    if (typeof window === "undefined") return null;
    try {
      const current = window.localStorage.getItem(storageKey);
      if (current) return current;
      const legacy = legacyKey ? window.localStorage.getItem(legacyKey) : null;
      return legacy ? `LEGACY:${legacy}` : null;
    } catch {
      return null;
    }
  }

  function parseStore(raw: string | null): ChatStore {
    if (!raw) return EMPTY_STORE;
    try {
      if (raw.startsWith("LEGACY:")) {
        const legacy = JSON.parse(raw.slice("LEGACY:".length)) as {
          messages?: ChatWireMessage[];
          updatedAt?: number;
        };
        const messages = asMessages(legacy?.messages);
        if (messages.length === 0) return EMPTY_STORE;
        const session: ChatSession = {
          id: newId(),
          title: deriveTitle(messages),
          messages,
          updatedAt: legacy?.updatedAt ?? Date.now(),
        };
        return { version: 2, activeId: session.id, sessions: [session] };
      }
      const parsed = JSON.parse(raw) as Partial<ChatStore>;
      if (!Array.isArray(parsed?.sessions)) return EMPTY_STORE;
      const sessions: ChatSession[] = [];
      for (const candidate of parsed.sessions) {
        if (!candidate || typeof candidate.id !== "string") continue;
        sessions.push({
          id: candidate.id,
          title: typeof candidate.title === "string" ? candidate.title : "",
          messages: asMessages(candidate.messages),
          updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
        });
      }
      const activeId =
        typeof parsed.activeId === "string" && sessions.some((s) => s.id === parsed.activeId)
          ? parsed.activeId
          : (sessions[0]?.id ?? "");
      return { version: 2, activeId, sessions };
    } catch {
      return EMPTY_STORE;
    }
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function writeStore(store: ChatStore): void {
    const next: ChatStore = {
      version: 2,
      activeId: store.activeId,
      sessions: boundSessions(
        store.sessions.map((s) => ({ ...s, messages: boundMessages(s.messages) })),
      ),
    };
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // quota / mode privé : l'historique reste en mémoire pour la session
      }
    }
    cachedRaw = undefined; // force une relecture au prochain instantané
    emit();
  }

  function getSnapshot(): ChatStore {
    const raw = readRaw();
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedStore = parseStore(raw);
    }
    return cachedStore;
  }

  function subscribe(callback: () => void): () => void {
    listeners.add(callback);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey || (legacyKey && event.key === legacyKey)) callback();
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(callback);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }

  function activeMessages(store: ChatStore): ChatWireMessage[] {
    return store.sessions.find((s) => s.id === store.activeId)?.messages ?? [];
  }

  function pastSessions(store: ChatStore): ChatSession[] {
    return store.sessions.filter((s) => s.messages.some((m) => m.role !== "system"));
  }

  function writeChat(messages: ChatWireMessage[]): void {
    const store = getSnapshot();
    let activeId = store.activeId;
    let sessions = store.sessions;
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      activeId = newId();
      sessions = [{ id: activeId, title: "", messages: [], updatedAt: 0 }, ...sessions];
    }
    sessions = sessions.map((session) =>
      session.id === activeId
        ? {
            ...session,
            messages,
            title: session.title || deriveTitle(messages),
            updatedAt: Date.now(),
          }
        : session,
    );
    writeStore({ version: 2, activeId, sessions });
  }

  function selectConversation(id: string): void {
    const store = getSnapshot();
    if (!store.sessions.some((s) => s.id === id)) return;
    writeStore({ ...store, activeId: id });
  }

  function deleteConversation(id: string): void {
    const store = getSnapshot();
    if (!store.sessions.some((s) => s.id === id)) return;
    const sessions = store.sessions.filter((s) => s.id !== id);
    const activeId = store.activeId === id ? (sessions[0]?.id ?? "") : store.activeId;
    writeStore({ version: 2, activeId, sessions });
  }

  function startNewConversation(): void {
    const store = getSnapshot();
    const active = store.sessions.find((s) => s.id === store.activeId);
    const hasContent = (active?.messages ?? []).some((m) => m.role !== "system");
    if (!hasContent) {
      emit(); // rien à archiver : on garde la conversation courante (déjà vide)
      return;
    }
    const fresh: ChatSession = { id: newId(), title: "", messages: [], updatedAt: Date.now() };
    writeStore({ version: 2, activeId: fresh.id, sessions: [fresh, ...store.sessions] });
  }

  return {
    subscribe,
    getSnapshot,
    getServerSnapshot: () => EMPTY_STORE,
    activeMessages,
    pastSessions,
    writeChat,
    selectConversation,
    deleteConversation,
    startNewConversation,
  };
}

/** Assistant musical global (panneau flottant). */
export const globalChatStore = createChatStore("neurobeats.chat.v2", "neurobeats.chat.v1");
/** Assistant dédié aux goûts (page Profil) : conversations séparées. */
export const profileChatStore = createChatStore("neurobeats.chat.profile.v1");

/** Abonne un composant à un store de conversations. */
export function useChatStore(api: ChatStoreApi): ChatStore {
  return useSyncExternalStore(api.subscribe, api.getSnapshot, api.getServerSnapshot);
}
