"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { visibleMessages, type ChatSession } from "@/lib/chat";
import { cn } from "cn";

/** Horodatage relatif compact (« il y a 5 min », « hier »…). */
function formatRelative(timestamp: number): string {
  if (!timestamp) return "";
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} j`;
  return new Date(timestamp).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
  });
}

/** Liste des conversations passées, avec restauration et suppression. */
export function ChatHistory({
  sessions,
  activeId,
  onSelect,
  onNewConversation,
  onDelete,
}: {
  sessions: ChatSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="nb-selectable flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            Aucune conversation passée.
          </p>
        ) : (
          <ul className="space-y-1" aria-label="Conversations passées">
            {sessions.map((session) => {
              const title = session.title || "Nouvelle conversation";
              const count = visibleMessages(session.messages).length;
              const isActive = session.id === activeId;
              return (
                <li key={session.id}>
                  <div
                    className={cn(
                      "group hover:bg-surface-hover flex items-center rounded-lg pr-1 transition-colors",
                      isActive && "bg-surface-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(session.id)}
                      aria-current={isActive ? "true" : undefined}
                      className="flex min-w-0 flex-1 flex-col gap-0.5 p-2.5 text-left"
                    >
                      <span className="truncate text-sm font-medium">
                        {title}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {count} message{count > 1 ? "s" : ""}
                        {session.updatedAt
                          ? ` · ${formatRelative(session.updatedAt)}`
                          : ""}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Supprimer la conversation « ${title} »`}
                      onClick={() => onDelete(session.id)}
                      className="text-muted-foreground hover:text-destructive shrink-0 opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-border border-t p-3">
        <Button
          variant="outline"
          onClick={onNewConversation}
          className="w-full rounded-full"
        >
          <MessageSquarePlus className="size-4" />
          Nouvelle conversation
        </Button>
      </div>
    </div>
  );
}
