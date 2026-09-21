"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Formulaire d'identité.
 *
 * Monté avec le contenu du modal : chaque ouverture repart donc de l'état
 * enregistré, sans effet de resynchronisation.
 */
function IdentityForm({
  firstName,
  lastName,
  busy,
  onCancel,
  onSubmit,
}: {
  firstName: string;
  lastName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { first_name: string; last_name: string }) => Promise<boolean>;
}) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [error, setError] = useState<string | null>(null);
  const changed = first.trim() !== firstName.trim() || last.trim() !== lastName.trim();

  async function submit() {
    const ok = await onSubmit({ first_name: first.trim(), last_name: last.trim() });
    if (ok) onCancel();
    else setError("Enregistrement impossible.");
  }

  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy) void submit();
      }}
    >
      <label className="block space-y-1.5">
        <span className="text-muted-foreground text-xs">Prénom</span>
        <input
          value={first}
          onChange={(event) => setFirst(event.target.value)}
          maxLength={60}
          autoFocus
          placeholder="Ton prénom"
          className="bg-surface-hover text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-lg px-3 text-sm outline-none focus-visible:ring-3"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-muted-foreground text-xs">Nom</span>
        <input
          value={last}
          onChange={(event) => setLast(event.target.value)}
          maxLength={60}
          placeholder="Ton nom"
          className="bg-surface-hover text-foreground placeholder:text-muted-foreground focus-visible:ring-ring/60 h-10 w-full rounded-lg px-3 text-sm outline-none focus-visible:ring-3"
        />
      </label>

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel} className="rounded-full">
          Annuler
        </Button>
        <Button type="submit" disabled={!changed || busy} className="rounded-full">
          {busy && <Loader2 className="size-4 animate-spin" />}
          Enregistrer
        </Button>
      </div>
    </form>
  );
}

/**
 * Édition du prénom et du nom.
 *
 * L'identité se consulte sur le profil ; la modification s'ouvre à la demande
 * (icône d'édition) pour ne pas laisser de champs de saisie à demeure.
 */
export function IdentityDialog({
  open,
  onOpenChange,
  firstName,
  lastName,
  busy = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firstName: string;
  lastName: string;
  busy?: boolean;
  onSubmit: (values: { first_name: string; last_name: string }) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="identity-dialog-desc" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Modifier mon identité</DialogTitle>
          <DialogDescription id="identity-dialog-desc">
            Ton prénom et ton nom apparaissent sur ton profil.
          </DialogDescription>
        </DialogHeader>
        <IdentityForm
          firstName={firstName}
          lastName={lastName}
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}
