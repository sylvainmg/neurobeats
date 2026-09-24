"""
Génère les icônes de l'application à partir du logo du web.

Source unique : `web/assets/logo-mark.png`. Le mark est blanc et détouré — les
barres du disque sont des réserves — donc invisible sur fond clair : on le
compose toujours sur le canvas de marque, jamais nu. Le `logo.jpeg` de la racine
n'est jamais lu.

Usage: python3 mobile/scripts/generer-assets.py
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent.parent.parent
SOURCE = RACINE / "web" / "assets" / "logo-mark.png"
IMAGES = Path(__file__).resolve().parent.parent / "assets" / "images"
CANVAS = (15, 20, 25, 255)  # #0f1419


def charger() -> Image.Image:
    if not SOURCE.exists():
        sys.exit(f"logo introuvable : {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def composer(mark: Image.Image, taille: int, part: float, fond=CANVAS) -> Image.Image:
    """Pose le mark centré, à `part` de la largeur, sur un carré uni."""
    toile = Image.new("RGBA", (taille, taille), fond)
    cible = max(1, int(taille * part))
    reduit = mark.resize((cible, cible), Image.LANCZOS)
    decalage = (taille - cible) // 2
    toile.alpha_composite(reduit, (decalage, decalage))
    return toile


def transparent(mark: Image.Image, taille: int, part: float) -> Image.Image:
    toile = Image.new("RGBA", (taille, taille), (0, 0, 0, 0))
    cible = max(1, int(taille * part))
    reduit = mark.resize((cible, cible), Image.LANCZOS)
    decalage = (taille - cible) // 2
    toile.alpha_composite(reduit, (decalage, decalage))
    return toile


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    mark = charger()
    # Le mark lui-même est copié tel quel : l'en-tête de l'application le pose sur
    # la surface sombre, exactement comme le fait le web.
    shutil.copyfile(SOURCE, IMAGES / "logo-mark.png")

    composer(mark, 1024, 0.62).save(IMAGES / "icon.png")
    # Zone sûre de l'icône adaptative : le mark tient dans les deux tiers centraux.
    composer(mark, 432, 0.44).save(IMAGES / "android-icon-foreground.png")
    Image.new("RGBA", (432, 432), CANVAS).save(IMAGES / "android-icon-background.png")
    composer(mark, 432, 0.44, fond=(0, 0, 0, 0)).save(IMAGES / "android-icon-monochrome.png")
    transparent(mark, 288, 0.82).save(IMAGES / "splash-icon.png")
    composer(mark, 48, 0.72).save(IMAGES / "favicon.png")

    for fichier in sorted(IMAGES.glob("*.png")):
        with Image.open(fichier) as image:
            print(f"  {fichier.name:32} {image.size[0]}x{image.size[1]}  {image.mode}")


if __name__ == "__main__":
    print("Icônes depuis web/assets/logo-mark.png")
    main()
