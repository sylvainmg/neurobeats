"use client";

import { Check, ListMusic, Play, Search, Sparkles } from "lucide-react";
import { cn } from "cn";

import { toolLabel } from "@/lib/chat";

/** Activité d'un outil pendant/après le streaming. */
export interface ToolActivity {
  name: string;
  label?: string;
  ok?: boolean;
}

function ToolIcon({ name }: { name: string }) {
  if (name.startsWith("play") || name === "skip_streaming" || name === "stop_music") {
    return <Play className="size-3" />;
  }
  if (name.includes("playlist") || name === "get_recommendation") {
    return <ListMusic className="size-3" />;
  }
  if (name === "search_music") return <Search className="size-3" />;
  return <Sparkles className="size-3" />;
}

/** Puces d'activité : ce que l'assistant est en train de faire (feedback d'attente). */
export function ChatToolActivity({ items }: { items: ToolActivity[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Actions de l'assistant">
      {items.map((item, index) => (
        <li
          key={`${item.name}-${index}`}
          className={cn(
            "border-border inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
            item.ok === false
              ? "text-destructive"
              : item.ok
                ? "text-muted-foreground"
                : "text-foreground",
          )}
        >
          {item.ok ? (
            <Check className="size-3" />
          ) : (
            <span className="inline-flex animate-pulse">
              <ToolIcon name={item.name} />
            </span>
          )}
          <span>{item.label || toolLabel(item.name)}</span>
        </li>
      ))}
    </ul>
  );
}
