"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, History, MessageSquarePlus, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AiSetupBanner } from "@/components/chat/ai-setup-banner";
import { ChatComposer, ChatMessages } from "@/components/chat/chat-messages";
import { ChatHistory } from "@/components/chat/chat-history";
import { useChatConversation } from "@/components/chat/use-chat";
import { globalChatStore } from "@/lib/chat";
import { useAiStatus } from "@/components/profile/ai-settings";
import { cn } from "cn";

const COMPOSER_ID = "chat-composer";

/** Panneau latéral de l'assistant musical : conversation streamée avec le backend. */
export function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chat = useChatConversation(globalChatStore, "global");
  const [showHistory, setShowHistory] = useState(false);
  const aiStatus = useAiStatus();
  // Désactive l'input et le bouton envoyer si modèle non configuré ou en chargement.
  const composerDisabled = !aiStatus?.configured || aiStatus.engine.state === "loading";

  // Focus du composer à l'ouverture (uniquement sur le fil, pas l'historique).
  useEffect(() => {
    if (!open || showHistory) return;
    document.getElementById(COMPOSER_ID)?.focus();
  }, [open, showHistory]);

  function handleNewConversation() {
    chat.newConversation();
    setShowHistory(false);
  }

  function handleOpenConversation(id: string) {
    chat.openConversation(id);
    setShowHistory(false);
  }

  return (
    <>
      {/* Voile sur mobile */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        aria-label="Assistant IA"
        className={cn(
          "bg-surface border-border fixed top-2 right-2 bottom-32 z-50 flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-transform duration-300 md:bottom-24",
          open ? "translate-x-0" : "translate-x-[calc(100%+0.5rem)]",
        )}
      >
        <header className="border-border flex items-center justify-between border-b px-4 py-3">
          <span className="flex items-center gap-2">
            <span className="bg-primary/15 text-primary flex size-7 items-center justify-center rounded-full">
              {showHistory ? <History className="size-4" /> : <Sparkles className="size-4" />}
            </span>
            <span className="text-sm font-semibold">
              {showHistory ? "Historique" : "Assistant"}
            </span>
          </span>
          <div className="flex items-center gap-1">
            {!showHistory && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Nouvelle conversation"
                onClick={handleNewConversation}
                className="text-muted-foreground hover:text-foreground rounded-full"
              >
                <MessageSquarePlus />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={showHistory ? "Retour à la conversation" : "Historique des conversations"}
              aria-pressed={showHistory}
              onClick={() => setShowHistory((value) => !value)}
              className={cn(
                "hover:text-foreground rounded-full",
                showHistory ? "text-primary hover:text-primary" : "text-muted-foreground",
              )}
            >
              {showHistory ? <ArrowLeft /> : <History />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fermer"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground rounded-full"
            >
              <X />
            </Button>
          </div>
        </header>

        {showHistory ? (
          <ChatHistory
            sessions={chat.sessions}
            activeId={chat.activeId}
            onSelect={handleOpenConversation}
            onNewConversation={handleNewConversation}
            onDelete={chat.deleteConversation}
          />
        ) : (
          <>
            <AiSetupBanner />
            <ChatMessages
              messages={chat.messages}
              streamingText={chat.streamText}
              toolActivity={chat.toolActivity}
              pending={chat.running}
            />

            {chat.error && (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
              >
                <span className="min-w-0 flex-1">{chat.error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void chat.send()}
                  className="text-destructive hover:text-destructive h-6 shrink-0 px-2 text-xs"
                >
                  Réessayer
                </Button>
              </div>
            )}

            <ChatComposer
              value={chat.draft}
              onChange={chat.setDraft}
              onSubmit={() => void chat.send()}
              onStop={chat.stop}
              running={chat.running}
              disabled={composerDisabled}
              inputId={COMPOSER_ID}
            />
          </>
        )}
      </aside>
    </>
  );
}
