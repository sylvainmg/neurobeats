"""Pochettes HQ : generation serveur des jaquettes carrees, cachees sur disque.

Pourquoi generer plutot que d'utiliser la vignette YouTube : YouTube ne publie
jamais plus de 1280x720 en 16/9, et pour une partie des videos — y compris
disponibles en 4K — aucune vignette HD n'existe. Or une carte carree de ~300 px
reclame 614 px de haut en DPR 2 et 921 px en DPR 3. Le plafond publie est donc
atteint, et une source plus grande doit venir de la video ou d'un catalogue.

Trois sources, essayees dans cet ordre ; la premiere qui passe est ecrite en webp
carre dans COVERS_DIR :

  1. jaquette d'album reelle (`services/coverart.py`) : carree, 1000 px et plus ;
  2. frame HD extraite de la video (`services/frame.py`), retenue seulement si
     elle ressemble a la vignette officielle (SSIM >= COVERS_SSIM_MIN) — on gagne
     en nettete sans changer l'image affichee ;
  3. vignette YouTube publiee, recadree : exactement l'image d'aujourd'hui.

Le **fichier** fait foi (un `.webp` present = une pochette disponible) ; la table
`covers` garde la provenance — quelle source, quel instant, quel score — et porte
le cache negatif des echecs. L'ordre d'eviction LRU vient de la date de
modification des fichiers, rafraichie a chaque lecture : il est donc correct des
le demarrage, sans dependre de la base.

Comme pour l'audio, rien ne doit peser sur la lecture : la generation tourne sur
un pool dedie de deux workers et l'endpoint, synchrone, attend dans le threadpool
de FastAPI — jamais sur la boucle d'evenements qui sert le son.
"""
import os
import threading
import time
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from tempfile import TemporaryDirectory

from core import db as engine_db
from core.config import (
    COVERS_BUDGET_MB, COVERS_DIR, COVERS_ENABLED, COVERS_MAX_WORKERS,
    COVERS_MISS_TTL, COVERS_SSIM_MIN, COVERS_TARGET_PX, COVERS_TTL_DAYS,
    VIDEO_ID_RE,
)
from services import coverart, frame

DOWNLOAD_TIMEOUT = 10.0
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # garde-fou : une image n'est jamais enorme
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) NeuroBeats/1.0"

# Instants candidats, en fraction de la duree. Volontairement concentres sur le
# debut : une vignette est presque toujours prise tot dans la video. Le tout
# premier instant est evite (fondus et cartons de generique).
OFFSET_RATIOS = (0.02, 0.06, 0.12, 0.25, 0.45, 0.7)
OFFSET_FLOOR = 3.0    # jamais avant 3 s
OFFSET_CEIL = 600.0   # au-dela, on n'insiste pas (titres longs : boucles)

# Echelle de vignettes publiees, de la meilleure a la plus disponible. Miroir de
# celle du client (web/lib/track.ts) : le serveur en a besoin comme reference de
# comparaison et comme dernier recours.
_THUMB_QUALITIES = ("maxresdefault", "hq720", "sddefault", "hqdefault", "mqdefault")
_THUMB_RANK = {name: index for index, name in enumerate(_THUMB_QUALITIES)}

_lock = threading.RLock()
_pool = None
_pool_lock = threading.Lock()
# video_id -> {"path", "bytes", "used"} ; ordre = LRU (date de derniere lecture).
_entries: "OrderedDict[str, dict]" = OrderedDict()
# Generations en cours : video_id -> Event signale a la fin (attente cote API).
_filling: dict = {}
_bytes_total = 0


def _path(video_id: str) -> str:
    return os.path.join(COVERS_DIR, f"{video_id}.webp")


def _log(message: str):
    """Journal des pochettes : visible sans TIMING (une generation est notable)."""
    print(f"  [covers] {message}", flush=True)


def stats() -> dict:
    with _lock:
        return {
            "enabled": COVERS_ENABLED,
            "tracks": len(_entries),
            "bytes": _bytes_total,
            "budget_bytes": COVERS_BUDGET_MB * 1024 * 1024,
            "filling": len(_filling),
            "target_px": COVERS_TARGET_PX,
            "ffmpeg": frame.available(),
        }


def has(video_id: str) -> bool:
    """True si la pochette est en cache. Sans effet de bord (pas de LRU)."""
    if not video_id:
        return False
    with _lock:
        return video_id in _entries


def generating(video_id: str) -> bool:
    """True si une generation est en cours pour ce titre (le client doit repasser)."""
    with _lock:
        return video_id in _filling


def read(video_id: str):
    """Octets de la pochette en cache, ou None. Rafraichit l'ordre LRU."""
    if not video_id:
        return None
    with _lock:
        entry = _entries.get(video_id)
        if entry is None:
            return None
        entry["used"] = time.time()
        _entries.move_to_end(video_id)
        path = entry["path"]
    try:
        os.utime(path)  # date de modification = date de derniere lecture
    except OSError:
        pass
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError:
        return None


def wait_read(video_id: str, timeout: float):
    """Octets de la pochette, en attendant au plus `timeout` une generation en cours.

    L'attente porte un `threading.Event` : elle est donc bornee et ne consomme
    aucun CPU. Appelee depuis l'endpoint synchrone (threadpool FastAPI), elle ne
    peut pas retarder la boucle d'evenements qui sert l'audio.
    """
    with _lock:
        event = _filling.get(video_id)
    if event is not None:
        event.wait(timeout)
    return read(video_id)


def clear() -> int:
    """Vide le cache : fichiers, index et lignes. Retourne le nombre de pochettes."""
    global _bytes_total
    with _lock:
        count = len(_entries)
        for video_id in list(_entries):
            _drop_locked(video_id)
        _bytes_total = 0
    try:
        engine_db.db_clear_covers()
    except Exception:
        pass
    return count


def warm():
    """Prepare le dossier et reconstruit l'index depuis le disque.

    Le disque fait foi : si la table est perdue ou partielle, les fichiers
    suffisent a servir les pochettes. La date de modification donne l'ordre LRU.
    """
    global _bytes_total
    try:
        engine_db.db_ensure_schema()  # la table `covers` peut manquer (base ancienne)
        os.makedirs(COVERS_DIR, exist_ok=True)
    except Exception as exc:
        _log(f"cache indisponible ({COVERS_DIR}) : {exc}")
        return
    found = {}
    try:
        names = os.listdir(COVERS_DIR)
    except OSError:
        names = []
    for name in names:
        path = os.path.join(COVERS_DIR, name)
        # Reste d'une generation interrompue : on l'efface plutot que de le
        # laisser passer pour une pochette.
        if name.endswith(".part"):
            _remove(path)
            continue
        if not name.endswith(".webp"):
            continue
        try:
            info = os.stat(path)
        except OSError:
            continue
        found[name[:-5]] = {"path": path, "bytes": info.st_size, "used": info.st_mtime}
    with _lock:
        _entries.clear()
        for video_id in sorted(found, key=lambda vid: found[vid]["used"]):
            _entries[video_id] = found[video_id]
        _bytes_total = sum(entry["bytes"] for entry in _entries.values())
    if _entries:
        _log(f"{len(_entries)} pochette(s) en cache ({_bytes_total // 1024} Ko)")
    _evict()


def ensure_async(video_id: str, title: str = "", channel: str = "",
                 duration=None) -> bool:
    """Programme la generation d'une pochette en tache de fond. Idempotent.

    Returns:
        True si une generation a ete lancee ; False si la pochette est deja la,
        deja en cours, desactivee, ou en echec recent (cache negatif).
    """
    if not COVERS_ENABLED or not video_id or not VIDEO_ID_RE.match(video_id):
        return False
    with _lock:
        if video_id in _entries or video_id in _filling:
            return False
    if _recently_failed(video_id):
        return False
    with _lock:
        if video_id in _entries or video_id in _filling:
            return False
        _filling[video_id] = threading.Event()
    try:
        _executor().submit(_generate_and_publish, video_id, title, channel, duration)
    except RuntimeError as exc:  # pool ferme (extinction du serveur)
        with _lock:
            _filling.pop(video_id, None)
        _log(f"generation refusee : {exc}")
        return False
    return True


def _executor():
    """Pool dedie aux pochettes : jamais un thread de l'API, jamais le son."""
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=COVERS_MAX_WORKERS,
                                       thread_name_prefix="covers")
        return _pool


def _generate_and_publish(video_id: str, title: str, channel: str, duration):
    """Genere une pochette, publie le resultat (ou l'echec), libere les waiters."""
    try:
        provenance = _generate(video_id, title, channel, duration)
    except Exception as exc:
        provenance = {}
        _log(f"{video_id} generation interrompue : {type(exc).__name__}: {exc}")
    # Un echec de publication (fichier absent) compte comme un echec : sans cela,
    # chaque requete relancerait une generation qui ne produit rien.
    if not (provenance and _publish(video_id, provenance)):
        _remember_miss(video_id)
    with _lock:
        event = _filling.pop(video_id, None)
    if event is not None:
        event.set()


def _generate(video_id: str, title: str, channel: str, duration) -> dict:
    """Essaie les trois sources et ecrit le webp carre. {} si tout echoue.

    Les metadonnees yt-dlp sont relues ici : elles donnent le vrai titre, la vraie
    chaine et la duree, dont depend le rapprochement d'album — la base ne connait
    que ce qui a ete joue ou cherche.
    """
    meta = frame.metadata(video_id)
    if meta.get("title"):
        title = meta["title"]
        channel = meta["channel"] or channel
    if meta.get("duration"):
        duration = meta["duration"]

    out = _path(video_id)
    with TemporaryDirectory(prefix="neurobeats-cover-") as tmp:
        # 1. Jaquette d'album : carree et grande, donc la plus nette.
        art = coverart.resolve(title, channel, duration)
        if art:
            source = os.path.join(tmp, "artwork")
            if _download(art["url"], source) and _produce(
                    out, lambda part: frame.square_webp(
                        source, part, COVERS_TARGET_PX, letterbox=False)):
                return {"source": "album", "provider": art["provider"],
                        "match_score": art["score"]}

        # La vignette publiee sert a la fois de reference d'identite (palier 2) et
        # de dernier recours (palier 3) : on la telecharge une seule fois.
        thumb = _published_thumb(meta, video_id, tmp)

        # 2. Frame HD, a condition qu'elle corresponde a la vignette officielle.
        offset, score = _match_frame(video_id, thumb, duration, tmp)
        if offset is not None and score is not None and score >= COVERS_SSIM_MIN:
            url = frame.video_url(video_id)
            if url:
                if _produce(out, lambda part: frame.frame_webp(
                        url, offset, part, COVERS_TARGET_PX)):
                    return {"source": "frame", "provider": "youtube",
                            "offset": offset, "match_score": score}
                _log(f"{video_id} extraction de frame echouee (SSIM {score:.2f})")

        # 3. Vignette publiee recadree : toujours disponible.
        if thumb and _produce(out, lambda part: frame.square_webp(
                thumb, part, COVERS_TARGET_PX, letterbox=True)):
            return {"source": "thumb", "provider": "youtube"}
    return {}


def _match_frame(video_id: str, thumb_path, duration, tmp: str):
    """Instant de la video qui ressemble le plus a la vignette officielle.

    Compare de petites versions (160x160) de la vignette et de plusieurs instants
    candidats : la frame finale est extraite avec le meme `-ss`, donc l'instant
    retenu est bien celui qu'on a valide.

    Returns:
        (offset, ssim) ; (None, None) si la comparaison est impossible (pas de
        vignette, duree inconnue, ffmpeg absent, flux video indisponible) — on
        passe alors au palier 3.
    """
    if not thumb_path or not duration or not frame.available():
        return None, None
    url = frame.video_url(video_id)
    if not url:
        return None, None

    reference = os.path.join(tmp, "ref.png")
    if not frame.image_square_png(thumb_path, reference, 160, letterbox=True):
        return None, None

    best = (None, None)
    for index, ratio in enumerate(OFFSET_RATIOS):
        offset = min(max(duration * ratio, OFFSET_FLOOR), OFFSET_CEIL)
        candidate = os.path.join(tmp, f"cand{index}.png")
        if not frame.grab(url, offset, candidate, size=160):
            continue
        score = frame.ssim(reference, candidate)
        if score is not None and (best[1] is None or score > best[1]):
            best = (offset, score)
    return best


def _produce(out: str, write) -> bool:
    """Ecrit une pochette de facon atomique : fichier `.part` puis renommage.

    Le cache n'expose donc jamais un fichier a moitie ecrit, et un plantage en
    pleine generation ne laisse pas de faux webp que `warm` prendrait pour une
    pochette valide.
    """
    part = f"{out}.part"
    if not write(part):
        _remove(part)
        return False
    try:
        os.replace(part, out)
    except OSError:
        _remove(part)
        return False
    return True


def _remove(path: str):
    try:
        os.remove(path)
    except OSError:
        pass


def _published_thumb(meta: dict, video_id: str, tmp: str):
    """Telecharge la meilleure vignette publiee. Chemin local, ou None."""
    for index, url in enumerate(_thumb_urls(meta, video_id)):
        out = os.path.join(tmp, f"thumb{index}")
        if _download(url, out):
            return out
    return None


def _thumb_urls(meta: dict, video_id: str) -> list:
    """URLs de vignette publiee, de la meilleure a la plus disponible.

    Le tri se fait sur le **nom** du fichier (`maxresdefault`, `hq720`,
    `sddefault`...), jamais sur les dimensions : yt-dlp ne les renseigne pas pour
    la plupart des variantes YouTube, et les autres entrees des metadonnees
    (`hq1`, `mq2`, `sd3`, `0.jpg`...) sont des plans de storyboard, pas des
    pochettes. Les URLs des metadonnees sont preferees (elles peuvent etre
    signees) ; l'echelle du client sert de repli derriere.
    """
    found = {}
    for thumb in meta.get("thumbnails") or []:
        url = thumb.get("url") or ""
        name = url.rsplit("/", 1)[-1].split("?")[0].rsplit(".", 1)[0]
        if name in _THUMB_RANK and name not in found:
            found[name] = url
    urls = [found[name] for name in sorted(found, key=_THUMB_RANK.get)]
    urls += [f"https://i.ytimg.com/vi/{video_id}/{quality}.jpg"
             for quality in _THUMB_QUALITIES]
    return urls


def _download(url: str, out: str) -> bool:
    """Telecharge une image (timeout borne). False si indisponible."""
    try:
        request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
            data = response.read(MAX_IMAGE_BYTES)
    except Exception:
        return False
    if not data:
        return False
    try:
        with open(out, "wb") as handle:
            handle.write(data)
    except OSError:
        return False
    return True


def _publish(video_id: str, provenance: dict) -> bool:
    """Enregistre la pochette produite : index RAM, table, eviction.

    Returns:
        False si le fichier attendu n'existe pas (l'appelant le traite en echec).
    """
    global _bytes_total
    path = _path(video_id)
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    with _lock:
        old = _entries.pop(video_id, None)
        if old is not None:
            _bytes_total -= old["bytes"]
        _entries[video_id] = {"path": path, "bytes": size, "used": time.time()}
        _bytes_total += size
    dimensions = frame.size(path) or (0, 0)
    try:
        engine_db.db_cover_put(
            video_id, source=provenance.get("source", ""),
            provider=provenance.get("provider", ""),
            offset=provenance.get("offset"),
            match_score=provenance.get("match_score"),
            width=dimensions[0], height=dimensions[1], bytes=size)
    except Exception as exc:
        _log(f"{video_id} provenance non enregistree : {exc}")
    _log(f"{video_id} prete ({provenance.get('source', '?')}, {size // 1024} Ko, "
         f"{dimensions[0]}x{dimensions[1]})")
    _evict()
    return True


def _remember_miss(video_id: str, error: str = ""):
    """Note un echec : inutile de relancer avant COVERS_MISS_TTL."""
    try:
        engine_db.db_cover_put(video_id, source="miss", error=error[:200])
    except Exception:
        pass
    _log(f"{video_id} sans source exploitable (vignette YouTube conservee)")


def _recently_failed(video_id: str) -> bool:
    """True si un echec recent interdit de relancer la generation."""
    try:
        row = engine_db.db_cover_get(video_id)
    except Exception:
        return False
    if not row or row.get("source") != "miss":
        return False
    try:
        age = time.time() - datetime.fromisoformat(row.get("created_at") or "").timestamp()
    except (TypeError, ValueError):
        return False
    return age < COVERS_MISS_TTL


def _evict():
    """Applique le TTL puis le budget disque, du plus ancien au plus recent."""
    global _bytes_total
    now = time.time()
    with _lock:
        for video_id in [vid for vid, entry in _entries.items()
                         if now - entry["used"] > COVERS_TTL_DAYS * 86400]:
            _drop_locked(video_id)
        budget = COVERS_BUDGET_MB * 1024 * 1024
        while budget > 0 and _entries and _bytes_total > budget:
            _drop_locked(next(iter(_entries)))


def _drop_locked(video_id: str):
    """Retire une pochette du cache : fichier, index et ligne (lock deja pris)."""
    global _bytes_total
    entry = _entries.pop(video_id, None)
    if entry is None:
        return
    _bytes_total -= entry["bytes"]
    try:
        os.remove(entry["path"])
    except OSError:
        pass
    try:
        engine_db.db_cover_delete(video_id)
    except Exception:
        pass
