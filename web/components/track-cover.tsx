"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

import { coverHqUrl, thumbnailCandidates } from "@/lib/track";
import { cn } from "cn";

/** Délai entre deux tentatives de pochette HQ, et nombre d'essais. */
const HQ_RETRY_MS = 2500;
const HQ_TRIES = 3;

/**
 * Source unique d'une pochette — une image, une décision, zéro substitution.
 *
 * `"auto"` et `"hq"` se distinguent précisément parce qu'ils ne se ressemblent
 * pas : `"auto"` superpose la vignette puis la remplace (donc l'image change une
 * fois à l'écran), `"hq"` n'affiche que la jaquette (donc elle apparaît une fois).
 * Choisir `"auto"` là où l'on veut une identité stable, c'est réintroduire le
 * changement sous les yeux du lecteur.
 */
export type CoverSource =
  /** Vignette YouTube seule : identité stable, pas d'appel backend. */
  | "thumbnail"
  /** Vignette YouTube, puis jaquette backend par-dessus (cartes, en-têtes). */
  | "auto"
  /** Pochette backend seule, sans vignette dessous : jamais de substitution. */
  | "hq";

/** Repli typographique : initiale du titre, si aucune jaquette ne charge. */
function CoverInitial({ title }: { title: string }) {
  return (
    <span className="from-primary/25 text-primary absolute inset-0 grid h-full w-full place-items-center bg-gradient-to-br to-transparent text-sm font-semibold">
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
  source,
}: {
  videoId: string;
  title: string;
  sizes: string;
  source: CoverSource;
}) {
  const sources = useMemo(() => thumbnailCandidates(videoId), [videoId]);
  const [index, setIndex] = useState(0);
  const thumb = sources[index];

  return (
    <>
      {/*
        Initiale posée DESSOUS, toujours visible : pendant le chargement de
        l'image (pas de carré gris vide, d'où ce "rien ne s'affiche" perçu sur
        les rafales d'historique) et seule quand toutes les vignettes échouent.
      */}
      <CoverInitial title={title} />
      {/*
        `"hq"` ne pose AUCUNE vignette dessous : la jaquette backend s'affiche
        seule, une fois, au-dessus de l'initiale. Superposer la vignette puis la
        remplacer faisait changer l'image sous l'œil du lecteur, ~2,5 s après
        l'ouverture (le backend répond 202 tant qu'il génère, le client retente
        toutes les 2,5 s). Une seule source = une seule apparition.
      */}
      {source === "hq" ? (
        <CoverHq videoId={videoId} />
      ) : (
        thumb && (
          <>
            <Image
              key={thumb.src}
              src={thumb.src}
              alt=""
              fill
              sizes={sizes}
              className="object-cover"
              // Une jaquette letterboxée est agrandie pour que ses bandes noires
              // sortent du carré, sans quoi elles apparaîtraient dans la pochette.
              style={thumb.zoom !== 1 ? { transform: `scale(${thumb.zoom})` } : undefined}
              onError={() => setIndex((current) => current + 1)}
            />
            {source === "auto" && <CoverHq videoId={videoId} />}
          </>
        )
      )}
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
 * `source` décide ce qui est affiché, et une seule chose à la fois :
 * - `"thumbnail"` : la vignette YouTube. Suffisant et instantané partout où
 *   l'icône du titre est déjà affichée à côté (file, lecteur, recherche) ;
 * - `"auto"` : la vignette, puis la pochette du backend quand elle est prête ;
 * - `"hq"` : la pochette du backend seule, sans vignette en dessous.
 *
 * Les deux derniers viennent de la même source que le backend, et pas
 * toujours de la même image : celle-ci cherche d'abord une vraie jaquette
 * d'album, puis une frame, puis la vignette recadrée. Un titre peut donc avoir
 * deux images légitimes selon la surface — c'est assumé. Ce qui ne l'est pas,
 * c'est de les faire changer pendant que l'utilisateur regarde : `"auto"`
 * remplace la vignette par la jaquette quelques secondes après l'affichage, ce
 * qui se voit comme un bug. Réserver `"auto"` aux grandes pochettes, dont
 * aucune autre image n'est affichée à côté, et `"hq"` aux vues où l'on préfère
 * attendre la jaquette plutôt que montrer la vignette.
 *
 * `sizes` ne sert qu'aux vignettes : la pochette du backend est déjà carrée et
 * dimensionnée (webp), elle n'est jamais passée par l'optimiseur d'images.
 */
export function TrackCover({
  videoId,
  title,
  sizes,
  className,
  rounded = "rounded-md",
  source = "thumbnail",
}: {
  videoId: string;
  title: string;
  sizes: string;
  className?: string;
  rounded?: string;
  source?: CoverSource;
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
          source={source}
        />
      ) : (
        <CoverInitial title={title} />
      )}
    </span>
  );
}
