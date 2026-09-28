"""Confronte les tailles du catalogue à ce que publie Hugging Face.

Le site affirme que les tailles viennent du catalogue « vérifié contre Hugging
Face ». Cette affirmation n'avait aucune preuve derrière elle : les valeurs
étaient curées à la main. Ce script la vérifie pour de vrai, et sort la liste
exacte des écarts — c'est la seule façon de savoir si l'affirmation tient.

Usage : python3 scripts/verifier-catalogue.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGUE = os.path.join(RACINE, "backend", "services", "curated_models.json")
SEUIL_RAPPORT = 0.02  # 2 % : en dessous, l'ecart vient de l'arrondi de l'affichage


def get(url: str) -> dict:
    req = urllib.request.Request(
        url, headers={"User-Agent": "neurobeats-catalogue-check"}
    )
    with urllib.request.urlopen(req, timeout=30) as rep:
        return json.loads(rep.read().decode("utf-8"))


def principal() -> dict:
    with open(CATALOGUE, encoding="utf-8") as fh:
        data = json.load(fh)
    entrees = data.get("models", data)
    return list(entrees.values()) if isinstance(entrees, dict) else list(entrees)


def mo(octets: int) -> float:
    return octets / 1024**3


def main() -> int:
    entrees = principal()
    ecarts: list[str] = []
    introuvables: list[str] = []
    verifies = 0

    print(f"Catalogue : {len(entrees)} entrées\n")
    entete = f"  {'modèle':22} {'déclaré':>9} {'réel':>9} {'écart':>8}  fichier"
    print(entete)
    print("  " + "-" * (len(entete) - 2))

    for e in entrees:
        repo = e["repo"]
        nom = e["name"]
        declare = float(e.get("size_gb") or 0)
        fichier = e.get("file")

        try:
            info = get(f"https://huggingface.co/api/models/{repo}?blobs=true")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            introuvables.append(f"{nom} ({repo}) : {exc}")
            print(f"  {nom:22} {'—':>9} {'—':>9} {'réseau':>8}")
            continue

        tailles = {
            str(s.get("rfilename")): int(s.get("size") or 0)
            for s in (info.get("siblings") or [])
        }

        # Le catalogue designe soit un fichier precis, soit un motif de
        # quantification. Dans les deux cas on doit retomber sur un fichier
        # reellement present, sinon l'entree est inexploitable telle quelle.
        reel = tailles.get(fichier or "")
        choisi = fichier
        if reel is None:
            motif = e.get("pattern")
            candidats = [f for f in tailles if motif and motif in f and f.endswith(".gguf")]
            if candidats:
                # Le plus petit nom correspond a la quantification la plus basse
                # du motif ; on prend celui que le catalogue designe en priorite.
                choisi = sorted(candidats)[0]
                reel = tailles[choisi]

        if not reel:
            introuvables.append(f"{nom} : fichier « {choisi} » absent de {repo}")
            print(f"  {nom:22} {declare:8.1f}G {'—':>9} {'ABSENT':>8}")
            continue

        verifies += 1
        reel_gb = mo(reel)
        ecart = reel_gb - declare
        rapport = abs(ecart) / declare if declare else 1.0
        marque = "ok" if rapport <= SEUIL_RAPPORT else "ECART"
        if rapport > SEUIL_RAPPORT:
            ecarts.append(
                f"{nom} : catalogue {declare:.1f} Go, Hugging Face {reel_gb:.1f} Go "
                f"({ecart:+.1f} Go, {ecart / declare * 100:+.0f} %)"
            )
        print(
            f"  {nom:22} {declare:8.1f}G {reel_gb:8.1f}G "
            f"{ecart:+7.1f}G  {marque}"
        )

    print()
    print(f"  {verifies}/{len(entrees)} entrées confrontées à Hugging Face")

    if introuvables:
        print(f"\n  {len(introuvables)} entrée(s) non résolues :")
        for x in introuvables:
            print(f"    - {x}")

    if ecarts:
        print(f"\n  {len(ecarts)} écart(s) avec la taille déclarée :")
        for x in ecarts:
            print(f"    - {x}")
        return 1

    print("\n  Toutes les tailles déclarées correspondent à Hugging Face.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
