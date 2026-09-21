"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

import { coverHqUrl, thumbnailCandidates } from "@/lib/track";
import { cn } from "cn";

/** Délai entre deux tentatives de pochette HQ, et nombre d'essais. */
const HQ_RETRY_MS = 2500;
const HQ_TRIES = 3;

/** Repli typographique : initiale du titre, si aucune jaquette ne charge. */
function CoverInitial({ title }: { title: string }) {
  return (
    <span className="from-primary/25 text-primary grid h-full w-full place-items-center bg-gradient-to-br to-transparent text-sm font-semibold">
      {(title || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Couche HQ servie par le backend, posée par-dessus la vignette YouTube.
 *
 * Elle n'apparaît qu'une fois l'image réellement chargée : tant que le serveur
 * n'a pas fini de générer la pochette il répond 202, et la vignette reste en
 * place — jamais de trou, jamais d'image fausse, et aucun blocage de l'affichage.
 */
function CoverHq({ videoId }: { videoId: string }) {
  const [src, setSrc] = useState(() => coverHqUrl(videoId));
  const [ready, setReady] = useState(false);
  const timer = useRef<number | null>(null);
  const tries = useRef(0);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  function retry() {
    // Échec définitif (vidéo privée, aucune source) ou trop d'essais : on en
    // reste à la vignette YouTube plutôt que d'insister.
    if (tries.current >= HQ_TRIES) {
      setSrc("");
      return;
    }
    tries.current += 1;
    timer.current = window.setTimeout(
      // Le paramètre force une nouvelle requête : le navigateur a pu mettre la
      // première en cache (réponse 202 vide).
      () => setSrc(`${coverHqUrl(videoId)}?r=${tries.current}`),
      HQ_RETRY_MS,
    );
  }

  if (!src) return null;
  return (
    // Un <Image> ici imposerait d'autoriser l'hote du backend dans next.config,
    // pour un optimiseur qui n'aurait rien a retoucher : le serveur renvoie deja
    // la taille exacte, en webp.
    // eslint-disable-next-line @next/next/no-img-element -- deja dimensionnee par le backend
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onLoad={() => setReady(true)}
      onError={retry}
      className={cn(
        "absolute inset-0 size-full object-cover transition-opacity duration-500 motion-reduce:transition-none",
        ready ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * Jaquette seule : essaie les formats du meilleur au plus disponible.
 *
 * Le parent la remonte via `key={videoId}` pour que la cascade reparte du
 * meilleur format à chaque changement de titre — le lecteur réutilise en effet
 * la même instance, qui garderait sinon l'échec du titre précédent.
 */
function CoverImage({
  videoId,
  title,
  sizes,
  hq,
}: {
  videoId: string;
  title: string;
  sizes: string;
  hq: boolean;
}) {
  const sources = useMemo(() => thumbnailCandidates(videoId), [videoId]);
  const [index, setIndex] = useState(0);
  const source = sources[index];

  if (!source) return <CoverInitial title={title} />;

  return (
    <>
      <Image
        key={source.src}
        src={source.src}
        alt=""
        fill
        sizes={sizes}
        className="object-cover"
        // Une jaquette letterboxée est agrandie pour que ses bandes noires
        // sortent du carré, sans quoi elles apparaîtraient dans la pochette.
        style={source.zoom !== 1 ? { transform: `scale(${source.zoom})` } : undefined}
        onError={() => setIndex((current) => current + 1)}
      />
      {hq && <CoverHq videoId={videoId} />}
    </>
  );
}

/**
 * Vignette d'un titre (jaquette YouTube), comme dans les résultats de recherche.
 *
 * La qualité servie par YouTube varie d'une vidéo à l'autre ; les formats hauts
 * sont donc tentés en cascade, car une jaquette 320×180 agrandie dans une
 * pochette carrée apparaît floue.
 *
 * `hq` ajoute la pochette générée par le backend (jaquette d'album, frame HD,
 * vignette recadrée), qui se substitue a la vignette dès qu'elle est prête. À
 * réserver aux grandes pochettes (cartes, en-têtes) : les petites vignettes sont
 * déjà nettes avec la vignette YouTube, et cela éviterait de générer pour rien.
 */
export function TrackCover({
  videoId,
  title,
  sizes,
  className,
  rounded = "rounded-md",
  hq = false,
}: {
  videoId: string;
  title: string;
  sizes: string;
  className?: string;
  rounded?: string;
  hq?: boolean;
}) {
  return (
    <span
      className={cn(
        "bg-surface-hover relative block shrink-0 overflow-hidden",
        rounded,
        className,
      )}
    >
      {videoId ? (
        <CoverImage
          key={videoId}
          videoId={videoId}
          title={title}
          sizes={sizes}
          hq={hq}
        />
      ) : (
        <CoverInitial title={title} />
      )}
    </span>
  );
}
