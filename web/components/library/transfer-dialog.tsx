"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Loader2, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, type TransferTicket } from "@/lib/api";

/**
 * Prépare un code de transfert, à la demande.
 *
 * Déclenché par l'ouverture (un événement), jamais par un effet : le lint du
 * projet interdit d'y modifier l'état, et une requête n'a rien à faire dans une
 * phase de synchronisation. Chaque appel rend un code neuf — un code déjà lu,
 * ou près d'expirer, ne doit pas resservir.
 */
export function useTransferTicket(playlistId: string) {
  const [ticket, setTicket] = useState<TransferTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const start = useCallback(async () => {
    setPending(true);
    setError(null);
    setTicket(null);
    try {
      setTicket(await api.mintTransfer(playlistId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Impossible de préparer le transfert",
      );
    } finally {
      setPending(false);
    }
  }, [playlistId]);

  return { ticket, error, pending, start };
}

/**
 * Modal « Transférer vers le téléphone » : affiche le code à scanner.
 *
 * Le code ne transporte pas la playlist : il porte une clé (session + jeton) que
 * le téléphone échange ensuite contre la liste, puis contre les fichiers, sur le
 * réseau local. Il n'est donc valable que quelques minutes, et le panneau le dit.
 *
 * Le QR est dessiné sur fond clair : un code clair sur fond sombre ne se scanne
 * pas de façon fiable.
 */
export function TransferDialog({
  open,
  onOpenChange,
  ticket,
  error,
  pending,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: TransferTicket | null;
  error: string | null;
  pending: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!ticket) return;
    try {
      await navigator.clipboard.writeText(ticket.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé : le lien reste lisible et sélectionnable à l'écran.
    }
  }

  const minutes = ticket ? Math.round(ticket.expire_dans / 60) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-4" />
            Transférer vers le téléphone
          </DialogTitle>
          <DialogDescription>
            Ouvre NeuroBeats sur ton téléphone, touche « Scanner un code », et
            vise celui-ci. Le téléphone doit être sur le même Wi-Fi que cet
            ordinateur.
          </DialogDescription>
        </DialogHeader>

        {pending && (
          <p className="text-muted-foreground flex items-center gap-2 px-4 py-10 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Préparation du transfert…
          </p>
        )}

        {error && !pending && (
          <div className="space-y-3 px-4 py-3">
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
            <Button variant="outline" onClick={onRetry}>
              Réessayer
            </Button>
          </div>
        )}

        {ticket && !pending && !error && (
          <div className="space-y-4 p-4">
            <div className="flex justify-center">
              <span className="rounded-xl bg-white p-3">
                <QRCodeSVG value={ticket.url} size={188} level="M" />
              </span>
            </div>

            <p className="text-muted-foreground text-center text-xs">
              {ticket.titres} titre{ticket.titres > 1 ? "s" : ""}
              {ticket.a_preparer > 0 &&
                ` · ${ticket.a_preparer} à préparer par cet ordinateur`}
              {ticket.prets > 0 && ` · ${ticket.prets} déjà en mémoire`}
              {` · code valable ${minutes} minutes`}
            </p>

            <div className="flex items-center gap-2">
              <code className="bg-surface-hover text-muted-foreground min-w-0 flex-1 truncate rounded-md px-3 py-2 text-xs">
                {ticket.url}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copié" : "Copier"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Si le scan échoue, envoie ce lien au téléphone : il s&apos;ouvre
              dans l&apos;app.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
