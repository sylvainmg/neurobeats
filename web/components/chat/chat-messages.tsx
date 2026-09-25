"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Send, Sparkles, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ChatToolActivity,
  type ToolActivity,
} from "@/components/chat/chat-tool-activity";
import { MAX_MESSAGE_CHARS, type ChatMessage } from "@/lib/chat";
import { cn } from "cn";

export type { ChatMessage };

/** Seuil d'apparition du compteur : on prévient avant la limite, sans harceler. */
const NEAR_LIMIT_CHARS = 200;

/** Rendu Markdown restreint (pas de HTML brut : sûreté). */
const MARKDOWN_COMPONENTS = {
  p: (props: React.ComponentProps<"p">) => (
    <p className="mb-2 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0" {...props} />
  ),
  ol: (props: React.ComponentProps<"ol">) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0" {...props} />
  ),
  li: (props: React.ComponentProps<"li">) => (
    <li className="marker:text-muted-foreground" {...props} />
  ),
  strong: (props: React.ComponentProps<"strong">) => (
    <strong className="font-semibold" {...props} />
  ),
  a: (props: React.ComponentProps<"a">) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2"
    />
  ),
  code: (props: React.ComponentProps<"code">) => (
    <code
      className="rounded bg-black/30 px-1 py-0.5 text-[0.85em]"
      {...props}
    />
  ),
  pre: (props: React.ComponentProps<"pre">) => (
    <pre
      className="mb-2 overflow-x-auto rounded-lg bg-black/30 p-2 text-xs last:mb-0"
      {...props}
    />
  ),
  h1: (props: React.ComponentProps<"h1">) => (
    <h1 className="mb-2 text-base font-semibold" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="mb-2 text-sm font-semibold" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="mb-1.5 text-sm font-semibold" {...props} />
  ),
};

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
}

/**
 * Fil de discussion : bulles utilisateur (bleu) / agent (surface), rendu Markdown.
 * Défilement collé en bas tant que l'utilisateur n'a pas remonté manuellement.
 */
export function ChatMessages({
  messages,
  streamingText = "",
  toolActivity = [],
  pending = false,
}: {
  messages: ChatMessage[];
  /** Texte de l'assistant en cours de streaming. */
  streamingText?: string;
  toolActivity?: ToolActivity[];
  /** Une requête est en cours (affiche l'indicateur d'attente avant le 1er token). */
  pending?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, toolActivity, pending, stickToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distance < 48);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }

  const showStream =
    Boolean(streamingText) || (pending && toolActivity.length === 0);
  const empty =
    messages.length === 0 && !showStream && toolActivity.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Conversation avec l'assistant"
        className="nb-selectable h-full space-y-4 overflow-y-auto p-4"
      >
        {empty && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="bg-primary/15 text-primary flex size-12 items-center justify-center rounded-full">
              <Sparkles className="size-6" />
            </span>
            <p className="text-foreground text-sm font-semibold">
              Assistant NeuroBeats
            </p>
            <p className="text-muted-foreground max-w-[16rem] text-xs">
              Demande une recommandation, lance un titre ou crée une playlist.
            </p>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={cn(
              "flex",
              message.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                message.role === "user"
                  ? "bg-primary text-primary-foreground rounded-br-sm"
                  : "bg-surface-hover text-foreground rounded-bl-sm",
              )}
            >
              {message.role === "user" ? (
                <span className="whitespace-pre-wrap">{message.content}</span>
              ) : (
                <Markdown content={message.content} />
              )}
            </div>
          </div>
        ))}

        {showStream && (
          <div className="flex justify-start">
            <div className="bg-surface-hover text-foreground max-w-[85%] rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-sm leading-relaxed">
              {streamingText ? (
                <Markdown content={streamingText} />
              ) : (
                <span className="text-muted-foreground">…</span>
              )}
            </div>
          </div>
        )}

        <ChatToolActivity items={toolActivity} />
        <div aria-hidden className="h-px" />
      </div>

      {!stickToBottom && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Aller au dernier message"
          onClick={scrollToBottom}
          className="bg-surface border-border absolute right-3 bottom-2 rounded-full border shadow-lg"
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

/** Zone de saisie : textarea auto-grandissant + bouton Envoyer/Stop. */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  running = false,
  disabled = false,
  inputId,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running?: boolean;
  /** Désactivé si modèle IA non configuré ou en chargement : input + bouton envoyable. */
  disabled?: boolean;
  inputId?: string;
}) {
  const canSend = value.trim().length > 0 && !disabled;
  const remaining = MAX_MESSAGE_CHARS - value.length;
  const atLimit = remaining <= 0;
  // Le compteur n'apparaît qu'à l'approche de la limite (pas de bruit en permanence).
  const nearLimit = !atLimit && remaining <= NEAR_LIMIT_CHARS;
  const helperId = inputId ? `${inputId}-helper` : undefined;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!running && canSend) onSubmit();
      }}
      className={cn("nb-selectable border-border border-t p-3", disabled && "opacity-50 pointer-events-none")}
    >
      <div className="flex items-stretch gap-2">
        <div
          className={cn(
            "bg-surface-hover flex-1 rounded-3xl",
            atLimit && "ring-destructive/50 ring-1",
          )}
        >
          <Textarea
            id={inputId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onSubmit={() => {
              if (!running && canSend) onSubmit();
            }}
            placeholder="Écris un message…"
            aria-label="Message à l'assistant"
            aria-multiline="true"
            aria-describedby={helperId}
            autoComplete="off"
            maxLength={MAX_MESSAGE_CHARS}
            disabled={disabled}
            className={cn(
              "text-foreground max-h-40 rounded-3xl",
              atLimit && "focus-visible:ring-destructive",
            )}
          />
        </div>
        {running ? (
          <Button
            type="button"
            size="icon"
            aria-label="Arrêter la réponse"
            onClick={onStop}
            className="rounded-full shrink-0"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="Envoyer"
            disabled={!canSend}
            className="rounded-full shrink-0"
          >
            <Send className="size-4" />
          </Button>
        )}
      </div>

      {/* Zone d'aide : espace réservé pour éviter tout saut de mise en page.
          Le compteur s'affiche seulement près de la limite ; l'annonce vocale
          (aria-live) ne se déclenche qu'à l'atteinte du plafond. */}
      <div className="mt-1.5 flex min-h-4 items-center justify-end px-1 text-xs">
        <span aria-live="polite" className="sr-only">
          {atLimit ? "Limite de caractères atteinte" : ""}
        </span>
        <span
          id={helperId}
          className={cn(
            "tabular-nums",
            atLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {atLimit
            ? `${MAX_MESSAGE_CHARS} caractères maximum atteints.`
            : nearLimit
              ? `${remaining} caractères restants`
              : ""}
        </span>
      </div>
    </form>
  );
}
