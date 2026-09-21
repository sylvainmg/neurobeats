"""Source video : metadonnees, flux, et images par ffmpeg.

Regroupe tout ce qui a besoin de la video elle-meme (par opposition a sa vignette
publiee) : les metadonnees yt-dlp — vignettes publiees, duree, hauteur max —, la
resolution d'un flux video, et les trois operations ffmpeg dont les pochettes ont
besoin : extraire une frame, produire un carre webp, comparer deux images.

Aucune dependance Python nouvelle : ffmpeg est le binaire systeme (comme mpv,
verifie au demarrage) et yt-dlp est deja la pour l'audio. Tout appel est borne
par un timeout — generer une pochette ne doit jamais immobiliser le moteur, la
lecture audio passe avant.
"""
import re
import shutil
import subprocess

from core.config import FFMPEG, YDL_CLIENT_SETS, YDL_INFO_OPTS, YDL_VIDEO_OPTS

# Bornes larges mais fermes : une frame = quelques centaines de Ko a lire, donc
# ces delais ne sont atteints que si le reseau stagne (on abandonne alors).
TIMEOUT_GRAB = 25.0
TIMEOUT_ENCODE = 30.0
TIMEOUT_SSIM = 20.0

# ffmpeg imprime `SSIM Y:.. U:.. V:.. All:0.912345 (..)` : seule la moyenne nous
# interesse (elle resume la ressemblance globale des deux images).
_SSIM_RE = re.compile(r"All:([0-9.]+)")

# Carré centre de l'image. Les expressions sont entre apostrophes : sans cela,
# les virgules internes de min() seraient lues comme des separateurs de filtres
# par le parseur de filtergraph.
_CENTER_SQUARE = "crop='min(iw,ih)':'min(iw,ih)'"
# Contenu 16/9 d'une image letterboxee (les vignettes 4:3 de YouTube ont des
# bandes noires qu'il faut retirer avant de recadrer en carre).
_SIXTEEN_NINE = "crop=iw:'min(ih,iw*9/16)'"


def available() -> bool:
    """True si ffmpeg est utilisable (sinon le palier frame est simplement saute)."""
    return bool(FFMPEG) and bool(shutil.which(FFMPEG))


def _run(args: list, timeout: float):
    """Execute ffmpeg ; None si indisponible, en echec ou trop lent.

    Un echec de ffmpeg est journalise (derniere ligne de stderr) : sans cela, une
    pochette qui ne se genere pas ne laisse aucune trace exploitable.
    """
    if not available():
        return None
    try:
        result = subprocess.run([FFMPEG, "-hide_banner", *args],
                                capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"  [frame] ffmpeg injoignable : {type(exc).__name__}", flush=True)
        return None
    if result.returncode != 0:
        lines = [line for line in (result.stderr or "").strip().splitlines() if line]
        print(f"  [frame] ffmpeg a echoue : {lines[-1] if lines else 'sans message'}",
              flush=True)
    return result


def _extract(video_id: str, opts: dict):
    """extract_info best-effort (None si la video est privée, bloquée, morte)."""
    from yt_dlp import YoutubeDL

    try:
        with YoutubeDL(opts) as ydl:
            return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=False)
    except Exception:
        return None


def metadata(video_id: str) -> dict:
    """Metadonnees utiles d'une video, ou {} si yt-dlp n'aboutit pas.

    Couteux (~1-3 s) : appele une seule fois par pochette generee, jamais sur le
    chemin d'affichage. Le titre et la chaine viennent d'ici plutot que de la
    base : ce sont ceux de YouTube, donc la reference pour rapprocher un album.
    """
    info = _extract(video_id, YDL_INFO_OPTS) or {}
    thumbnails = [
        {"url": t["url"], "width": t.get("width"), "height": t.get("height")}
        for t in (info.get("thumbnails") or []) if t.get("url")
    ]
    heights = [f.get("height") for f in (info.get("formats") or []) if f.get("height")]
    return {
        "thumbnails": thumbnails,
        "duration": info.get("duration"),
        "max_height": max(heights) if heights else 0,
        "title": info.get("title") or "",
        "channel": info.get("channel") or info.get("uploader") or "",
    }


def video_url(video_id: str) -> str | None:
    """URL du flux video borne en hauteur, pour extraire une frame.

    Meme repli que la resolution audio : plusieurs jeux de clients YouTube, car
    le format video n'est pas servi par les memes clients selon la video.
    """
    for clients in YDL_CLIENT_SETS:
        opts = dict(YDL_VIDEO_OPTS)
        opts["extractor_args"] = {"youtube": {"player_client": list(clients),
                                              "skip": ["hls"]}}
        info = _extract(video_id, opts)
        url = (info or {}).get("url")
        if url:
            return url
    return None


def grab(url: str, ts: float, out_png: str, size: int = 160) -> bool:
    """Extrait la frame du carre centre a l'instant `ts` en petit PNG.

    `-ss` avant `-i` = seek rapide cote entree : ffmpeg ne lit que ce qu'il faut
    du flux (requetes Range), au lieu de telecharger la video jusqu'a l'instant
    voulu. La precision s'arrete a la keyframe, ce qui suffit pour une image — et
    reste identique pour la frame finale, extraite avec le meme `-ss`.
    """
    res = _run(["-loglevel", "error", "-ss", f"{ts:.2f}", "-i", url,
                "-frames:v", "1", "-vf", f"{_CENTER_SQUARE},scale={size}:{size}",
                "-y", out_png], TIMEOUT_GRAB)
    return bool(res and res.returncode == 0)


def image_square_png(src: str, out: str, size: int, letterbox: bool = True) -> bool:
    """Ecrit une petite version carree de `src` (reference de comparaison SSIM)."""
    filters = [_CENTER_SQUARE]
    if letterbox:
        filters.insert(0, _SIXTEEN_NINE)
    filters.append(f"scale={size}:{size}")
    res = _run(["-loglevel", "error", "-i", src, "-frames:v", "1",
                "-vf", ",".join(filters), "-y", out], TIMEOUT_ENCODE)
    return bool(res and res.returncode == 0)


def frame_webp(url: str, ts: float, out: str, cap_px: int) -> bool:
    """Extrait la frame du carre centre a `ts`, en webp plafonne a `cap_px`.

    Meme `-ss` (et donc meme image) que la frame candidate qui a servi a valider
    l'instant, et jamais d'agrandissement : si la video ne propose que du 720p, on
    stocke du 720 — le navigateur reduit, il n'agrandit pas.
    """
    res = _run(["-loglevel", "error", "-ss", f"{ts:.2f}", "-i", url,
                "-frames:v", "1",
                "-vf", f"{_CENTER_SQUARE},scale='min(iw,{cap_px})':'min(ih,{cap_px})':flags=lanczos",
                "-c:v", "libwebp", "-quality", "88",
                # Format impose : le fichier de sortie passe par un `.part` (ecriture
                # atomique), dont l'extension ne dit rien a ffmpeg.
                "-f", "webp", "-y", out], TIMEOUT_ENCODE)
    return bool(res and res.returncode == 0)


def size(path: str):
    """(largeur, hauteur) d'une image, ou None (ffprobe, best-effort)."""
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    try:
        res = subprocess.run(
            [probe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=10)
        width, height = res.stdout.strip().split(",")
        return int(width), int(height)
    except Exception:
        return None


def square_webp(src: str, out: str, cap_px: int, letterbox: bool = True) -> bool:
    """Ecrit `src` en carre webp plafonne a `cap_px`, sans jamais agrandir.

    `letterbox=True` retire d'abord les bandes noires (vignettes 4:3 de YouTube) :
    le carre obtenu cadre alors le contenu 16/9, exactement ce que montre l'UI.
    `letterbox=False` pour une jaquette d'album, deja carree.
    """
    filters = [_CENTER_SQUARE]
    if letterbox:
        filters.insert(0, _SIXTEEN_NINE)
    filters.append(f"scale='min(iw,{cap_px})':'min(ih,{cap_px})':flags=lanczos")
    res = _run(["-loglevel", "error", "-i", src, "-frames:v", "1",
                "-vf", ",".join(filters), "-c:v", "libwebp", "-quality", "88",
                "-f", "webp", "-y", out], TIMEOUT_ENCODE)
    return bool(res and res.returncode == 0)


def ssim(ref_png: str, cand_png: str) -> float | None:
    """Similarite structurelle entre deux images de meme taille, ou None.

    Sert de garde-fou d'identite : une frame de la video ne remplace la vignette
    officielle que si elle lui ressemble vraiment.
    """
    res = _run(["-loglevel", "info", "-i", ref_png, "-i", cand_png,
                "-lavfi", "ssim", "-f", "null", "-"], TIMEOUT_SSIM)
    if res is None:
        return None
    match = _SSIM_RE.search(res.stderr or "")
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None
