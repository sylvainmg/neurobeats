"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, History, MessageSquarePlus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AiSetupBanner } from "@/components/chat/ai-setup-banner";
import { ChatComposer, ChatMessages } from "@/components/chat/chat-messages";
import { ChatHistory } from "@/components/chat/chat-history";
import { useChatConversation } from "@/components/chat/use-chat";
import { profileChatStore } from "@/lib/chat";
import { useAiStatus } from "@/components/profile/ai-settings";
import { cn } from "cn";

const COMPOSER_ID = "profile-chat-composer";

const SUGGESTIONS = [
  "Résume mes goûts",
  "Quels sont mes artistes favoris ?",
  "Note mon dernier titre 4 étoiles",
  "Supprime un titre de mon historique",
];

/**
 * Assistant dédié aux goûts.
 *
 * Vit dans l'onglet qui lui est consacré : plus de fenêtre modale, la
 * conversation occupe toute la surface disponible — fil scrollable au centre,
 * champ de saisie épinglé en bas — et l'état vide propose des points de départ.
 *
 * On repart d'une conversation vierge à chaque ouverture du Profil : la
 * précédente reste dans l'historique (bouton dédié), mais elle n'est plus
 * rechargée d'office. L'onglet étant monté — mais masqué — dès l'arrivée sur la
 * page, ce fil neuf est déjà en place quand l'utilisateur ouvre l'assistant : il
 * ne voit donc jamais l'ancienne conversation apparaître puis être remplacée.
 */
export function TasteAssistant({ active }: { active: boolean }) {
  const chat = useChatConversation(profileChatStore, "profile");
  const [showHistory, setShowHistory] = useState(false);
  const { newConversation } = chat;
  const aiStatus = useAiStatus();
  // Désactive l'input et le bouton envoyer si modèle non configuré ou en chargement.
  const composerDisabled = !aiStatus?.configured || aiStatus.engine.state === "loading";

  // Fil neuf à chaque ouverture du Profil. `newConversation` est stable (mémoïsé
  // par le hook) : l'effet ne s'exécute donc qu'une fois, au montage.
  useEffect(() => {
    newConversation();
  }, [newConversation]);

  // Fil vierge : on montre l'accueil plutôt qu'une zone vide.
  const empty = chat.messages.length === 0;

  // Le champ prend le focus à l'ouverture de l'onglet : on peut écrire aussitôt.
  // On attend une frame : le panneau est masqué tant que l'onglet n'est pas
  // actif, un focus immédiat ne prendrait donc pas.
  useEffect(() => {
    if (!active || showHistory) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(COMPOSER_ID)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, showHistory]);

  // Relance la dernière demande après une erreur (le champ, lui, est déjà vidé).
  function retry() {
    const messages = chat.messages;
    let last = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        last = index;
        break;
      }
    }
    if (last < 0) return;
    void chat.send(
      messages[last].content,
      messages.slice(0, last).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    );
  }

  return (
    <section
      aria-labelledby="taste-title"
      className="bg-surface border-border my-auto flex h-[min(62dvh,600px)] min-h-0 flex-col overflow-hidden rounded-xl border"
    >
      <header className="border-border flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="bg-primary/15 text-primary grid size-8 shrink-0 place-items-center rounded-full">
            {showHistory ? (
              <History className="size-4" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </span>
          <h2 id="taste-title" className="truncate text-base font-semibold">
            {showHistory ? "Conversations passées" : "Assistant de tes goûts"}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Nouvelle conversation"
            onClick={() => {
              chat.newConversation();
              setShowHistory(false);
            }}
            className="text-muted-foreground hover:text-foreground rounded-full"
          >
            <MessageSquarePlus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              showHistory
                ? "Retour à la conversation"
                : "Historique des conversations"
            }
            aria-pressed={showHistory}
            onClick={() => setShowHistory((value) => !value)}
            className={cn(
              "hover:text-foreground rounded-full",
              showHistory
                ? "text-primary hover:text-primary"
                : "text-muted-foreground",
            )}
          >
            {showHistory ? <ArrowLeft /> : <History />}
          </Button>
        </div>
      </header>

      {showHistory ? (
        <ChatHistory
          sessions={chat.sessions}
          activeId={chat.activeId}
          onSelect={(id) => {
            chat.openConversation(id);
            setShowHistory(false);
          }}
          onNewConversation={() => {
            chat.newConversation();
            setShowHistory(false);
          }}
          onDelete={chat.deleteConversation}
        />
      ) : (
        <>
          {/* Bandeau discret si aucun modèle IA n'est réglé (le reste fonctionne). */}
          <AiSetupBanner />
          {empty ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto overscroll-contain p-6 text-center">
              <span className="bg-primary/15 text-primary grid size-14 place-items-center rounded-full">
                <Sparkles className="size-6" />
              </span>
              <div className="space-y-1">
                <p className="text-base font-semibold">
                  Parle-moi de tes goûts
                </p>
                <p className="text-muted-foreground mx-auto max-w-sm text-sm">
                  Résume tes écoutes, note des titres, gère tes favoris et ton
                  historique.
                </p>
              </div>
              <ul className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      onClick={() => void chat.sendFresh(suggestion)}
                      className="border-border text-muted-foreground hover:text-foreground hover:border-primary/60 focus-visible:ring-ring/50 rounded-full border px-3 py-1.5 text-xs transition-colors focus-visible:ring-3 focus-visible:outline-none"
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ChatMessages
              messages={chat.messages}
              streamingText={chat.streamText}
              toolActivity={chat.toolActivity}
              pending={chat.running}
            />
          )}

          {chat.error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/10 text-destructive mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1">{chat.error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={retry}
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
    </section>
  );
}
