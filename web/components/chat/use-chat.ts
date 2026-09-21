"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ToolActivity } from "@/components/chat/chat-tool-activity";
import { ApiError, chatStream, type ChatScope, type ChatWireMessage } from "@/lib/api";
import {
  MAX_MESSAGE_CHARS,
  useChatStore,
  visibleMessages,
  type ChatStoreApi,
} from "@/lib/chat";

/** Message d'erreur lisible pour l'utilisateur. */
export function friendlyChatError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Backend injoignable. Vérifie que le serveur tourne.";
    if (error.status === 504) return "L'assistant met trop de temps à répondre.";
    return error.message;
  }
  return "Une erreur est survenue. Réessaie.";
}

/**
 * Conversation avec le backend, adossée à un store de conversations.
 *
 * Partagé par l'assistant global (panneau flottant) et l'assistant dédié du
 * Profil : même logique de streaming, de tool-calls et d'annulation, seuls le
 * store et la portée (`scope`) changent.
 */
export function useChatConversation(api: ChatStoreApi, scope: ChatScope = "global") {
  const store = useChatStore(api);
  const wire = api.activeMessages(store);
  const sessions = api.pastSessions(store);

  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [toolActivity, setToolActivity] = useState<ToolActivity[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef("");
  const inFlight = useRef(false);

  // Annule un flux en cours au démontage.
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Envoie un message. `override` permet d'envoyer un texte venu d'un autre
   * composer (lanceur) sans dépendre de l'état `draft` du moment. `base` permet
   * de repartir d'un fil précis plutôt que de celui du rendu.
   */
  const send = useCallback(
    async (override?: string, base: ChatWireMessage[] = wire) => {
      // Garde-fou : plafond par message, aligné sur la limite serveur.
      const text = (override ?? draft).trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || inFlight.current) return;
      inFlight.current = true;

      const outgoing: ChatWireMessage[] = [
        ...base,
        { role: "user", content: text },
      ];
      api.writeChat(outgoing);
      setDraft("");
      setError(null);
      setToolActivity([]);
      setStreamText("");
      streamRef.current = "";
      setRunning(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const activity: ToolActivity[] = [];
      let finalMessages: ChatWireMessage[] | null = null;

      try {
        await chatStream(
          outgoing,
          (event) => {
            if (event.type === "token") {
              streamRef.current += event.content;
              setStreamText(streamRef.current);
            } else if (event.type === "tool_start") {
              activity.push({ name: event.name, label: event.label });
              setToolActivity([...activity]);
            } else if (event.type === "tool_end") {
              const pending = activity.findIndex(
                (a) => a.name === event.name && a.ok === undefined,
              );
              if (pending >= 0)
                activity[pending] = { ...activity[pending], ok: event.ok ?? true };
              else activity.push({ name: event.name, label: event.label, ok: event.ok ?? true });
              setToolActivity([...activity]);
            } else if (event.type === "done") {
              finalMessages = event.messages;
            } else if (event.type === "error") {
              setError(event.error);
            }
          },
          controller.signal,
          scope,
        );
      } catch (err) {
        if (!controller.signal.aborted) setError(friendlyChatError(err));
      } finally {
        abortRef.current = null;
        inFlight.current = false;
        setRunning(false);
        const partial = streamRef.current.trim();
        streamRef.current = "";
        setStreamText("");
        if (finalMessages) {
          api.writeChat(finalMessages);
        } else if (partial) {
          // Réponse interrompue : on garde ce qui a été reçu.
          api.writeChat([...outgoing, { role: "assistant", content: partial }]);
        }
      }
    },
    [draft, wire, api, scope],
  );

  /**
   * Envoie un message dans une conversation vierge.
   *
   * L'instance précédente est archivée (elle reste dans l'historique, d'où elle
   * peut être reprise explicitement). Sert aux points d'entrée qui ouvrent un
   * nouveau sujet plutôt qu'ils ne poursuivent le fil courant.
   */
  const sendFresh = useCallback(
    async (text: string) => {
      api.startNewConversation();
      await send(text, []);
    },
    [api, send],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setDraft("");
    setError(null);
    setToolActivity([]);
    setStreamText("");
    streamRef.current = "";
  }, []);

  const newConversation = useCallback(() => {
    reset();
    api.startNewConversation();
  }, [reset, api]);

  const openConversation = useCallback(
    (id: string) => {
      reset();
      api.selectConversation(id);
    },
    [reset, api],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      api.deleteConversation(id);
    },
    [api],
  );

  return {
    messages: visibleMessages(wire),
    sessions,
    activeId: store.activeId,
    draft,
    setDraft,
    streamText,
    toolActivity,
    running,
    error,
    send,
    sendFresh,
    stop,
    newConversation,
    openConversation,
    deleteConversation,
  };
}
