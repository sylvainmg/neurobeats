"use client";

import { useRef, useState } from "react";
import { Camera, ImageUp, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "cn";

const AVATAR_SIZE = 512; // px : reste net une fois affiche en grand (et en retina)
const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 Mo en entrée
const HINT = "PNG, JPEG ou WebP · 5 Mo max";
const INPUT_ID = "profile-avatar-input";
const HINT_ID = "profile-avatar-hint";

/**
 * Réduit et recadre l'image en carré `AVATAR_SIZE`×`AVATAR_SIZE`, puis renvoie un
 * data URL WebP : c'est ce qui est envoyé au backend (photo intégrée au profil,
 * aucune dépendance d'upload).
 */
async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("Retouche d'image indisponible dans ce navigateur.");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close?.();
  return canvas.toDataURL("image/webp", 0.85);
}

/**
 * Photo de profil : import par clic ou glisser-déposer, retrait.
 *
 * L'image est recadrée en carré et réduite dans le navigateur avant l'envoi, et
 * le survol de la vignette annonce l'action disponible.
 */
export function AvatarPicker({
  avatar,
  displayName,
  busy = false,
  onChange,
  onClear,
}: {
  avatar: string;
  displayName: string;
  busy?: boolean;
  onChange: (dataUrl: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Choisis un fichier image (png, jpeg ou webp).");
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      setError("Image trop lourde (5 Mo maximum).");
      return;
    }
    setWorking(true);
    try {
      onChange(await toAvatarDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import impossible.");
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  const disabled = working || busy;

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label={
          avatar ? "Changer la photo de profil" : "Importer une photo de profil"
        }
        aria-describedby={HINT_ID}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        className={cn(
          "group bg-surface-hover border-border focus-visible:ring-ring/60 relative grid size-40 shrink-0 place-items-center overflow-hidden rounded-full border transition-[color,background-color,border-color,transform] focus-visible:ring-3 focus-visible:outline-none active:scale-[0.98] sm:size-48",
          disabled && "opacity-70",
          dropping && "border-primary ring-primary/40 ring-4",
        )}
      >
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL locale, pas d'optimisation Next
          <img src={avatar} alt="" className="size-full object-cover" />
        ) : initials ? (
          <span className="text-muted-foreground text-5xl font-semibold">
            {initials}
          </span>
        ) : (
          <Camera className="text-muted-foreground size-10" />
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {disabled ? (
            <Loader2 className="size-7 animate-spin text-white" />
          ) : (
            <Camera className="size-7 text-white" />
          )}
        </span>
      </button>

      <input
        ref={inputRef}
        id={INPUT_ID}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="Photo de profil"
        aria-describedby={HINT_ID}
        className="hidden"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <div className="flex flex-wrap items-center justify-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-label={
            avatar
              ? "Changer la photo de profil"
              : "Importer une photo de profil"
          }
          className="rounded-full text-xs"
        >
          <ImageUp className="size-3.5" />
          {avatar ? "Changer" : "Importer"}
        </Button>
        {avatar && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={busy}
            aria-label="Retirer la photo de profil"
            className="text-muted-foreground hover:text-destructive rounded-full text-xs"
          >
            <Trash2 className="size-3.5" />
            Retirer
          </Button>
        )}
      </div>

      <p
        id={HINT_ID}
        className="text-muted-foreground max-w-48 text-center text-[11px]"
      >
        {error ? <span className="text-destructive">{error}</span> : HINT}
      </p>
    </div>
  );
}
