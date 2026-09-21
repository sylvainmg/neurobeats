"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { NowPlayingState, QueueState } from "@/lib/api";

/**
 * Connexion temps reel au backend.
 *
 * Le moteur audio tourne cote serveur : le navigateur n'est qu'une telecommande.
 * Ce WebSocket pousse l'etat (lecture + file) au lieu de le poller, et sert de
 * presence — le serveur arrete le flux quand plus aucun client n'est connecte.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function wsUrl() {
  return `${API_URL.replace(/^http/, "ws")}/ws`;
}

interface RealtimeValue {
  now: NowPlayingState | null;
  queue: QueueState | null;
  connected: boolean;
  /** Revision des playlists : change des qu'une playlist est modifiee cote serveur. */
  playlistsRev: number;
  /** Revision des ecoutes (historique + compteurs) : change a chaque ecoute. */
  statsRev: number;
  /** Revision des donnees de profil (notes, favoris, playlists, identite). */
  profileRev: number;
}

const RealtimeContext = createContext<RealtimeValue>({
  now: null,
  queue: null,
  connected: false,
  playlistsRev: 0,
  statsRev: 0,
  profileRev: 0,
});

const PING_INTERVAL = 15_000;
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5_000;

/** Ouvre et maintient la connexion temps reel (provider racine, toutes les routes). */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [now, setNow] = useState<NowPlayingState | null>(null);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [connected, setConnected] = useState(false);
  const [playlistsRev, setPlaylistsRev] = useState(0);
  const [statsRev, setStatsRev] = useState(0);
  const [profileRev, setProfileRev] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const pingRef = useRef<number | null>(null);
  const reconnectRef = useRef<number | null>(null);

  useEffect(() => {
    let closed = false;

    function clearTimers() {
      if (pingRef.current) window.clearInterval(pingRef.current);
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      pingRef.current = null;
      reconnectRef.current = null;
    }

    function connect() {
      if (closed) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
        // Heartbeat : garde la connexion vivante (proxy) et detecte les clients morts.
        pingRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            now?: NowPlayingState;
            queue?: QueueState;
            playlists_rev?: number;
            stats_rev?: number;
            profile_rev?: number;
          };
          if (msg?.type === "snapshot") {
            if (msg.now) setNow(msg.now);
            if (msg.queue) setQueue(msg.queue);
            if (typeof msg.playlists_rev === "number")
              setPlaylistsRev(msg.playlists_rev);
            if (typeof msg.stats_rev === "number") setStatsRev(msg.stats_rev);
            if (typeof msg.profile_rev === "number")
              setProfileRev(msg.profile_rev);
          }
        } catch {
          // message illisible : on ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingRef.current) window.clearInterval(pingRef.current);
        if (closed) return;
        // Reconnexion avec backoff : un reload doit reprendre vite (grace serveur 10s).
        const delay = Math.min(
          RECONNECT_MIN * 2 ** retryRef.current,
          RECONNECT_MAX,
        );
        retryRef.current += 1;
        reconnectRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      closed = true;
      clearTimers();
      wsRef.current?.close();
    };
  }, []);

  return (
    <RealtimeContext.Provider
      value={{ now, queue, connected, playlistsRev, statsRev, profileRev }}
    >
      {children}
    </RealtimeContext.Provider>
  );
}

/** Etat temps reel pousse par le serveur (lecture + file + connexion). */
export function useRealtime() {
  return useContext(RealtimeContext);
}
