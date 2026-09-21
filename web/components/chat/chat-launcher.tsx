"use client";

import { useEffect } from "react";

import { ChatFab } from "@/components/chat/chat-fab";
import { ChatPanel } from "@/components/chat/chat-panel";
import { globalChatStore } from "@/lib/chat";
import { useOverlays } from "@/lib/overlays";

/** Orchestrateur du chatbot : bouton flottant + panneau latéral. */
export function ChatLauncher() {
  const { chatOpen, setChatOpen } = useOverlays();

  // Au lancement de l'application, on repart sur une conversation vierge : la
  // précédente reste consultable dans l'historique. Idempotent (sans contenu,
  // `startNewConversation` ne crée rien), donc sûr en double montage.
  useEffect(() => {
    globalChatStore.startNewConversation();
  }, []);

  // Échap ferme le panneau.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setChatOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setChatOpen]);

  return (
    <>
      <ChatFab open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />
      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  );
}
