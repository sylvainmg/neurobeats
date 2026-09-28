"""Modeles IA locaux : catalogue, sonde materielle, telechargement, serveur d'inference.

Pour rendre NeuroBeats utilisable sans configuration (pas d'Ollama/LM Studio/BYOK),
l'app desktop peut telecharger un modele GGUF et le faire tourner LOCALEMENT via
`llama-server` (llama.cpp), qui parle une API OpenAI-compatible — le provider
`embedded` de services/llm.py s'y branche sans nouvelle abstraction.

Choix de design :
- Catalogue CURE (curated_models.json) plutot qu'un outil type whichllm : la liste
  est filtrable sur ce qui compte pour NeuroBeats (tool-calling + francais), elle
  fonctionne hors-ligne, et elle ne depend d'aucune API tierce au runtime. Les
  tailles/qualites sont vetues ; le resolv de fichier reste dynamique (HF API).
- Chaque transfert actif tourne dans son propre processus. Le service conserve
  seulement des metadonnees JSON sur disque ; il peut donc etre arrete/repris
  sans transformer un thread Python en etat global fragile.
- Le serveur d'inference est LAZY : demarre a la demande (RAM), tue a l'arret.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from core.config import sans_fenetre_console

from services.state import _tprint

# ------------------------------------------------------------------- repertoire modeles
# L'app desktop pointe NEUROBEATS_MODELS_DIR vers son userData ; en dev on retombe
# sur le repertoire de donnees standard de la plateforme. NEUROBEATS_PROFILE
# isole les profils web/desktop qui n'exposent pas de variable dediee.
def _profile_slug() -> str:
    profile = (os.environ.get("NEUROBEATS_PROFILE") or "web").strip() or "web"
    return "".join(char for char in profile if char.isalnum() or char in "-_")[:32] or "web"


def _legacy_models_dir() -> str | None:
    """Ancien emplacement Win/Mac (sans profil) pour migration des .gguf."""
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "NeuroBeats", "models")
    if system == "Darwin":
        return os.path.join(os.path.expanduser("~"), "Library",
                            "Application Support", "NeuroBeats", "models")
    return None


def models_dir() -> str:
    env = os.environ.get("NEUROBEATS_MODELS_DIR")
    if env:
        return env
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "neurobeats", _profile_slug(), "models")
    if system == "Darwin":
        return os.path.join(os.path.expanduser("~"), "Library",
                            "Application Support", "neurobeats",
                            _profile_slug(), "models")
    profile = _profile_slug()
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "neurobeats", profile, "models")


def _migrate_legacy_models() -> None:
    """Deplace les .gguf de l'ancien dossier (sans profil) vers le nouveau."""
    legacy = _legacy_models_dir()
    if not legacy:
        return
    target = os.path.abspath(models_dir())
    source = os.path.abspath(legacy)
    if source == target or not os.path.isdir(source):
        return
    try:
        names = os.listdir(source)
    except OSError:
        return
    moved = [n for n in names if n.endswith(".gguf")]
    if not moved:
        return
    os.makedirs(target, exist_ok=True)
    for name in moved:
        src, dst = os.path.join(source, name), os.path.join(target, name)
        if os.path.isfile(dst):
            continue
        try:
            os.replace(src, dst)
        except OSError:
            try:
                shutil.copy2(src, dst)
            except OSError:
                pass


def _manifest_path() -> str:
    return os.path.join(models_dir(), "manifest.json")


# ------------------------------------------------------------------- catalogue
_CATALOG: dict | None = None
_CATALOG_SOURCE: str | None = None
_CATALOG_LOCK = threading.Lock()


def catalog() -> dict:
    """Catalogue cure des modeles recommandables (charge une fois)."""
    global _CATALOG, _CATALOG_SOURCE
    path = os.environ.get("NEUROBEATS_CATALOG_PATH") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "curated_models.json")
    if _CATALOG is None or _CATALOG_SOURCE != path:
        with _CATALOG_LOCK:
            if _CATALOG is None or _CATALOG_SOURCE != path:
                with open(path, encoding="utf-8") as fh:
                    _CATALOG = json.load(fh)
                _CATALOG_SOURCE = path
    return _CATALOG


def catalog_models() -> list[dict]:
    return list(catalog().get("models", []))


def _entry(model_id: str) -> dict:
    """Entree d'un modele : catalogue cure, puis manifeste (modeles Hugging Face).

    Un modele telecharge hors catalogue (recherche Hub) doit se comporter comme
    les autres : c'est le manifeste qui porte alors `repo`/`pattern`/`ctx`, donc
    une seule source pour ce que l'app possede.
    """
    for entry in catalog_models():
        if entry["id"] == model_id:
            return entry
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            record = _read_manifest_unlocked().get(str(model_id))
    if isinstance(record, dict) and record.get("file"):
        return {
            "id": str(model_id),
            "name": str(record.get("name") or model_id),
            "repo": str(record.get("repo") or ""),
            "file": str(record.get("file") or ""),
            "pattern": str(record.get("pattern") or ""),
            "ctx": int(record.get("ctx") or 8192),
            "size_gb": round(float(record.get("size_bytes") or 0) / 1024 ** 3, 3),
        }
    raise ValueError(f"Modele inconnu du catalogue : {model_id!r}")


def custom_entry(repo: str, filename: str, size_bytes: int = 0,
                 ctx: int = 8192) -> dict:
    """Entree d'un modele choisi sur Hugging Face (hors catalogue cure).

    L'identifiant encode repo + fichier : deux quantifications du meme repo sont
    donc deux modeles distincts, et la cle reste stable entre deux sessions.
    """
    repo = (repo or "").strip()
    filename = (filename or "").strip()
    if not repo or "/" not in repo:
        raise ValueError(f"Depot Hugging Face invalide : {repo!r}")
    if not filename or not filename.endswith(".gguf"):
        raise ValueError(f"Fichier GGUF attendu : {filename!r}")
    try:
        size_gb = round(max(0, int(size_bytes)) / 1024 ** 3, 3)
    except (TypeError, ValueError):
        size_gb = 0.0
    return {
        "id": f"{repo}/{filename}",
        "name": filename[:-len(".gguf")],
        "repo": repo,
        "file": filename,
        "pattern": filename,
        "ctx": max(1024, int(ctx or 8192)),
        "size_gb": size_gb,
        "custom": True,
    }


# ------------------------------------------------------------------- sonde materielle
def _mem_total_gb() -> float:
    """RAM systeme en Go (fiable sur Win/macOS/Linux, sans dependance lourde)."""
    try:
        if platform.system() == "Windows":
            import ctypes
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX(dwLength=ctypes.sizeof(stat))
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / (1024 ** 3)
        if platform.system() == "Darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True,
                                 text=True, timeout=5).stdout.strip()
            return int(out) / (1024 ** 3)
        # Linux
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return kb / (1024 ** 2)
    except Exception as exc:
        _tprint(f"[models] sonde RAM echouee : {exc}")
    return 8.0  # repli prudent


def _gpu_info() -> dict | None:
    """GPU le plus capable : NVIDIA (nvidia-smi), AMD (rocm-smi), sinon None."""
    try:
        for cmd, vendor in ((("nvidia-smi", "--query-gpu=name,memory.total",
                              "--format=csv,noheader,nounits"), "nvidia"),
                            (("rocm-smi", "--showmeminfo", "vram"), "amd")):
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=8,
                                 **sans_fenetre_console())
            if out.returncode != 0 or not out.stdout.strip():
                continue
            if vendor == "nvidia":
                name, mem = [part.strip() for part in out.stdout.splitlines()[0].split(",")[:2]]
                return {"vendor": "nvidia", "name": name, "vram_gb": float(mem) / 1024.0}
            if vendor == "amd":
                return {"vendor": "amd", "name": "AMD GPU", "vram_gb": 0.0}
    except Exception as exc:
        _tprint(f"[models] sonde GPU echouee : {exc}")
    return None


def probe_hardware() -> dict:
    """Description du materiel pour la reco (RAM, CPU, GPU, disque)."""
    is_apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
    gpu = _gpu_info()
    if is_apple_silicon:
        # Apple Silicon : la mémoire est unifiée, le GPU consomme la RAM système.
        gpu = {"vendor": "apple", "name": "Apple Silicon (Metal)", "vram_gb": 0.0}
    disk_free_gb = 0.0
    try:
        os.makedirs(models_dir(), exist_ok=True)
        disk_free_gb = shutil.disk_usage(models_dir()).free / (1024 ** 3)
    except OSError:
        pass
    return {
        "os": platform.system(),
        "arch": platform.machine(),
        "cpu_cores": os.cpu_count() or 0,
        "ram_gb": round(_mem_total_gb(), 1),
        "gpu": gpu,
        "disk_free_gb": round(disk_free_gb, 1),
        "unified_memory": is_apple_silicon,
    }


def _mem_budget_gb(hw: dict) -> float:
    """Memoire utilisable pour inference : VRAM si GPU NVIDIA, sinon RAM."""
    gpu = hw.get("gpu") or {}
    if gpu.get("vendor") == "nvidia" and gpu.get("vram_gb", 0) >= 4:
        return gpu["vram_gb"]
    if gpu.get("vendor") == "apple":
        return hw.get("ram_gb", 8.0)
    # CPU-only : on reserves ~2 Go au reste de l'app.
    return max(hw.get("ram_gb", 8.0) - 2.0, 2.0)


def recommend() -> str:
    """Proposes les modeles du catalogue qui tiennent sur la machine, classes.

    Retourne un JSON (contrat run_tool) : {hardware, models, best}. Chaque modele
    porte `fits` (ca passe en RAM), `dl_mb`, et un indice qualite/memoire.
    """
    hw = probe_hardware()
    budget = _mem_budget_gb(hw)
    out = []
    for entry in sorted(catalog_models(), key=lambda m: -m.get("quality", 0)):
        fits = budget >= entry.get("min_ram_gb", 99)
        rec = {
            "id": entry["id"], "name": entry["name"], "family": entry.get("family", ""),
            "size_gb": entry.get("size_gb", 0), "dl_mb": int(entry.get("size_gb", 0) * 1024),
            "min_ram_gb": entry.get("min_ram_gb", 0), "tier": entry.get("tier", ""),
            "quality": entry.get("quality", 0), "french": entry.get("french", 0),
            "tool_calling": entry.get("tool_calling", ""), "license": entry.get("license", ""),
            "ctx": entry.get("ctx", 8192), "notes": entry.get("notes", ""),
            "fits": fits,
            "downloadable": bool(entry.get("file") or entry.get("pattern")),
        }
        out.append(rec)
    best = next((m for m in out if m["fits"]), None)
    return json.dumps({
        "hardware": hw,
        "memory_budget_gb": round(budget, 1),
        "models": out,
        "best": best["id"] if best else None,
    }, ensure_ascii=False)


# ------------------------------------------------------------------ verrous de fichiers
@contextmanager
def _exclusive_file_lock(path: str) -> Iterator[None]:
    """Prend un verrou consultatif inter-processus autour d'un fichier JSON.

    Le verrou en memoire reste la protection rapide dans un backend. Le verrou
    fichier evite qu'une autre instance du backend ne remplace le JSON entre sa
    lecture et son ecriture. ``fcntl`` est disponible sur les plateformes Unix ;
    Windows utilise le verrou natif de ``msvcrt`` quand il est present.
    """
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    handle = open(path + ".lock", "a+", encoding="utf-8")
    locked = False
    try:
        if os.name == "nt":
            try:
                import msvcrt
                handle.seek(0)
                if handle.read(1) == "":
                    handle.write("0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                locked = True
            except (ImportError, OSError):
                locked = False
        else:
            try:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                locked = True
            except (ImportError, OSError):
                locked = False
        yield
    finally:
        if locked:
            try:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
        handle.close()


# ----------------------------------------------------------- manifeste (telecharges)
def _read_manifest_unlocked() -> dict:
    try:
        with open(_manifest_path(), encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def list_downloaded() -> str:
    """Modeles deja telecharges (manifeste + scan disque en secours)."""
    _MANIFEST_LOCK.acquire()
    try:
        manifest = _read_manifest_unlocked()
    finally:
        _MANIFEST_LOCK.release()
    os.makedirs(models_dir(), exist_ok=True)
    on_disk = []
    for name in sorted(os.listdir(models_dir())):
        if name.endswith(".gguf") or name.endswith(".gguf.partial"):
            on_disk.append(name)
    return json.dumps({"models": manifest, "files": on_disk}, ensure_ascii=False, default=str)


def is_downloaded(model_id: str) -> bool:
    """True si ce modele est au manifeste et que son fichier est present."""
    model_id = str(model_id or "")
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            manifest = _read_manifest_unlocked()
    entry = manifest.get(model_id)
    return bool(entry and entry.get("file") and os.path.isfile(entry["file"]))


# ------------------------------------------------------------------- telechargement
# Les etats et les processus sont deux choses distinctes : un processus peut
# disparaitre (redemarrage du backend) alors que le staging doit rester intact.
class DownloadJobNotFound(LookupError):
    """Le job demande n'existe pas dans le registre durable."""


class DownloadConflict(RuntimeError):
    """La transition demandee n'est pas valide pour l'etat courant."""


_ACTIVE_STATUSES = {"starting", "resolving", "downloading", "cancelling"}
_TERMINAL_STATUSES = {"done", "error", "cancelled"}
_KNOWN_STATUSES = _ACTIVE_STATUSES | _TERMINAL_STATUSES | {"paused"}
# Les job_id naissent de _next_job_id (entiers incrementaux). Tout autre
# format vient d'un registre altere ou d'une entree utilisateur : on le
# rejette avant tout acces disque pour fermer la traversee "../".
_JOB_ID_RE = re.compile(r"^[0-9]{1,12}$")
_MANIFEST_LOCK = threading.RLock()
_JOBS_LOCK = threading.RLock()
_DOWNLOAD_JOBS: dict[str, dict] = {}
_PROCESSES: dict[str, Any] = {}
_PROGRESS_CACHE: dict[str, tuple[int, float]] = {}
_STATE_PATH: str | None = None
_PROCESS_FACTORY = None


def _downloads_dir() -> str:
    return os.path.join(models_dir(), ".downloads")


def _jobs_path() -> str:
    return os.path.join(_downloads_dir(), "jobs.json")


def _check_job_id(job_id: str) -> str:
    """Valide un job_id avant tout acces disque (anti-traversee ``../``)."""
    value = str(job_id or "")
    if not _JOB_ID_RE.match(value):
        raise DownloadJobNotFound(f"Job de telechargement inconnu : {value!r}")
    return value


def _job_staging_dir(job_id: str) -> str:
    return os.path.join(_downloads_dir(), "staging", str(job_id))


def _confined_staging_dir(job: dict) -> str:
    """Rejette un staging_dir hors de ``.downloads/staging`` (registre altere)."""
    root = os.path.abspath(os.path.join(_downloads_dir(), "staging"))
    candidate = os.path.abspath(str(job.get("staging_dir") or ""))
    if candidate != root and not candidate.startswith(root + os.sep):
        raise DownloadJobNotFound(
            f"Job de telechargement inconnu : {job.get('job_id')!r}")
    return candidate


def _job_result_path(job_id: str) -> str:
    return os.path.join(_job_staging_dir(job_id), "worker-result.json")


def _job_payload_path(job_id: str) -> str:
    return os.path.join(_job_staging_dir(job_id), "worker-payload.json")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value or default))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or default)
    except (TypeError, ValueError):
        return default


def _normalise_job(raw: dict, job_id: str) -> dict:
    """Complète un ancien JSON sans jamais conserver d'objet Python non JSON."""
    status = str(raw.get("status") or "paused")
    if status == "canceled":
        status = "cancelled"
    if status not in _KNOWN_STATUSES:
        status = "paused"
    staging_dir = str(raw.get("staging_dir") or _job_staging_dir(job_id))
    entry = raw.get("entry")
    if not isinstance(entry, dict):
        entry = {}
    return {
        "job_id": job_id,
        "model_id": str(raw.get("model_id") or ""),
        "status": status,
        "received": _as_int(raw.get("received")),
        "total": _as_int(raw.get("total")),
        "pct": min(100.0, max(0.0, _as_float(raw.get("pct")))),
        "speed_mbps": max(0.0, _as_float(raw.get("speed_mbps"))),
        "error": raw.get("error"),
        "file": raw.get("file"),
        "filename": str(raw.get("filename") or entry.get("file") or ""),
        "repo_id": str(raw.get("repo_id") or entry.get("repo") or ""),
        "pattern": str(raw.get("pattern") or entry.get("pattern") or ""),
        "staging_dir": staging_dir,
        "entry": dict(entry),
        "created_at": raw.get("created_at") or _now(),
        "updated_at": raw.get("updated_at") or raw.get("created_at") or _now(),
        "pid": raw.get("pid"),
        "control": raw.get("control") or None,
    }


def _load_jobs_locked() -> dict[str, dict]:
    global _DOWNLOAD_JOBS, _STATE_PATH
    path = _jobs_path()
    if _STATE_PATH != path:
        # Le chemin depend de l'environnement (et des tests). Ne melange jamais
        # deux profils dans le cache memoire.
        _STATE_PATH = path
        _DOWNLOAD_JOBS = {}
        _PROCESSES.clear()
        _PROGRESS_CACHE.clear()
    jobs: dict[str, dict] = {}
    with _exclusive_file_lock(path):
        try:
            with open(path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError):
            payload = {}
        raw_jobs = payload.get("jobs", {}) if isinstance(payload, dict) else {}
        if isinstance(raw_jobs, list):
            raw_jobs = {str(item.get("job_id")): item for item in raw_jobs
                        if isinstance(item, dict) and item.get("job_id") is not None}
        if isinstance(raw_jobs, dict):
            for raw_id, raw in raw_jobs.items():
                if isinstance(raw, dict):
                    job_id = str(raw.get("job_id") or raw_id)
                    jobs[job_id] = _normalise_job(raw, job_id)
    _DOWNLOAD_JOBS = jobs
    return jobs


def _write_jobs_locked(jobs: dict[str, dict]) -> None:
    global _DOWNLOAD_JOBS
    _DOWNLOAD_JOBS = jobs
    path = _jobs_path()
    payload = {"version": 1, "jobs": jobs}
    with _exclusive_file_lock(path):
        os.makedirs(_downloads_dir(), exist_ok=True)
        temporary = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)


def _job_state(job_id: str) -> dict:
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(str(job_id))
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        return job


def _resolve_gguf(entry: dict) -> tuple[str, str]:
    """Resout un fichier GGUF pour les appelants historiques de tests/outils.

    Le vrai transfert ne fait pas cette resolution dans le thread HTTP : le
    worker la realised avant d'appeler Hugging Face.
    """
    repo, exact = entry.get("repo", ""), entry.get("file") or ""
    pattern = entry.get("pattern") or ""
    if exact:
        return repo, exact
    from huggingface_hub import list_repo_files
    candidates = [name for name in list_repo_files(repo) if name.endswith(".gguf")]
    for name in candidates:
        if pattern and pattern in name:
            return repo, name
    if candidates:
        return repo, candidates[0]
    raise RuntimeError("Impossible de resoudre le fichier GGUF (reseau requis).")


def _next_job_id(jobs: dict[str, dict]) -> str:
    numbers = []
    for job_id in jobs:
        try:
            numbers.append(int(job_id))
        except (TypeError, ValueError):
            pass
    return str(max(numbers, default=0) + 1)


def _touch(job: dict) -> None:
    job["updated_at"] = _now()


def _public_job(job: dict) -> dict:
    """Constat public stable pour le REST et le flux SSE.

    Les chemins HF et les objets de pilotage restent internes. ``staging_path``
    est expose uniquement comme diagnostic de reprise ; le contrat principal
    reste les neuf champs de progression/document dates. ``speed_mbps`` (Mo/s,
    estimation glissante) permet a l'UI d'afficher la vitesse en clair.
    """
    return {
        "job_id": str(job.get("job_id", "")),
        "model_id": str(job.get("model_id", "")),
        "status": str(job.get("status", "paused")),
        "received": _as_int(job.get("received")),
        "total": _as_int(job.get("total")),
        "pct": round(min(100.0, max(0.0, _as_float(job.get("pct")))), 2),
        "speed_mbps": round(max(0.0, _as_float(job.get("speed_mbps"))), 2),
        "error": job.get("error"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "staging_path": job.get("staging_dir"),
    }


def _snapshot_locked(jobs: dict[str, dict], job_id: str) -> dict:
    job = jobs.get(_check_job_id(job_id))
    if job is None:
        raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
    return _public_job(dict(job))


def _worker_payload(job: dict) -> dict[str, Any]:
    return {
        "job_id": str(job["job_id"]),
        "model_id": str(job["model_id"]),
        "repo_id": str(job["repo_id"]),
        "filename": str(job.get("filename") or ""),
        "pattern": str(job.get("pattern") or ""),
        "total": _as_int(job.get("total")),
        "models_dir": os.path.abspath(models_dir()),
        "staging_dir": os.path.abspath(str(job["staging_dir"])),
        "result_path": os.path.abspath(_job_result_path(str(job["job_id"]))),
    }


def _worker_env() -> dict[str, str]:
    """Construit l'environnement du worker de téléchargement.

    Le cache de chunks xet peut peser plusieurs gigaoctets : il est confine au
    repertoire de modeles de l'instance pour ne pas etre partage avec le
    workflow web, ni polluer le cache Hugging Face global de l'utilisateur.
    """
    env = os.environ.copy()
    env["NEUROBEATS_DOWNLOAD_WORKER"] = "1"
    xet_cache = str(Path(_downloads_dir()) / "xet-cache")
    env["HF_XET_CACHE"] = xet_cache
    env["HF_HOME"] = str(Path(_downloads_dir()) / "hf-home")
    return env


def _new_worker_process(payload: dict[str, Any]) -> Any:
    """Cree un worker identifiable dans le groupe de processus du backend.

    Le lancement par ``python -m services.model_download_worker`` garde le nom
    du module dans ``/proc`` ; le reaper Electron peut ainsi eliminer un worker
    orphelin meme si le leader backend a deja disparu. L'absence de ``start_new_session`` est volontaire :
    le worker reste dans le PGID backend et recoit donc le meme arrete de groupe.
    Le hook est uniquement pour les tests.
    """
    if _PROCESS_FACTORY is not None:
        return _PROCESS_FACTORY(payload)

    payload_path = Path(_job_payload_path(str(payload["job_id"])))
    payload_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = payload_path.with_name(f".{payload_path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, payload_path)

    script = Path(__file__).with_name("model_download_worker.py").resolve()
    env = _worker_env()
    return subprocess.Popen(
        [sys.executable, "-m", "services.model_download_worker", str(payload_path)],
        cwd=str(script.parent.parent),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        **sans_fenetre_console(),
    )


def _process_running(process: Any) -> bool:
    try:
        return process.poll() is None
    except (AttributeError, OSError):
        return False


def _join_process(process: Any, timeout: float | None = None) -> None:
    join = getattr(process, "join", None)
    if join is not None:
        join(timeout)
        return
    wait = getattr(process, "wait", None)
    if wait is not None:
        wait(timeout)


def _stop_process(process: Any | None) -> bool:
    """Termine puis reap un worker, avec un kill de secours."""
    if process is None:
        return True
    try:
        if not _process_running(process):
            _join_process(process, 0)
            return True
    except Exception:
        return True
    try:
        process.terminate()
    except Exception:
        return False
    try:
        _join_process(process, 5)
    except Exception:
        pass
    if _process_running(process):
        try:
            process.kill()
        except Exception:
            return False
        try:
            _join_process(process, 2)
        except Exception:
            pass
    return not _process_running(process)


def _launch_job_locked(jobs: dict[str, dict], job: dict) -> bool:
    """ Lance le worker d'un job deja persistant sous ``_JOBS_LOCK``. """
    job_id = str(job["job_id"])
    staging_dir = str(job["staging_dir"])
    os.makedirs(staging_dir, exist_ok=True)
    result_path = _job_result_path(job_id)
    try:
        os.unlink(result_path)
    except FileNotFoundError:
        pass
    except OSError:
        pass
    job["status"] = "starting"
    job["control"] = None
    job["error"] = None
    job["pid"] = None
    _update_progress_locked(jobs, job)
    try:
        process = _new_worker_process(_worker_payload(job))
        if hasattr(process, "daemon"):
            process.daemon = False
        start = getattr(process, "start", None)
        if callable(start):
            start()
    except Exception as exc:
        job["status"] = "error"
        job["error"] = f"Worker impossible à démarrer : {type(exc).__name__}: {exc}"[:500]
        job["pid"] = None
        _touch(job)
        _write_jobs_locked(jobs)
        return False
    _PROCESSES[job_id] = process
    job["pid"] = getattr(process, "pid", None)
    _touch(job)
    _write_jobs_locked(jobs)
    return True


def _read_worker_result(job: dict) -> dict:
    try:
        with open(_job_result_path(str(job["job_id"])), encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _apply_worker_result_locked(jobs: dict[str, dict], job: dict, result: dict) -> bool:
    """Applique le résultat durable ; retourne True si l'etat a change."""
    status = result.get("status")
    if status not in ("done", "error"):
        return False
    if status == "done":
        file = str(result.get("file") or "")
        if not file or not os.path.isfile(file):
            job["status"] = "error"
            job["error"] = "Le worker a annoncé la fin mais le fichier est absent."
            job["file"] = None
        else:
            job["status"] = "done"
            job["error"] = None
            job["file"] = file
            job["filename"] = str(result.get("filename") or job.get("filename") or "")
            job["received"] = _as_int(result.get("received"), os.path.getsize(file))
            # Le total du catalogue est une estimation arrondie : une fois le
            # fichier publie, seule la taille reelle fait foi (sinon un job
            # termine reste affiche a 88 % pour toujours).
            job["total"] = job["received"]
            job["pct"] = 100.0
            job["speed_mbps"] = 0.0
            entry = dict(job.get("entry") or {})
            entry.setdefault("name", job.get("model_id", ""))
            _record_manifest(job["model_id"], file, entry)
            _maybe_load_selected(str(job["model_id"]))
    else:
        job["status"] = "error"
        job["error"] = str(result.get("error") or "Téléchargement échoué.")[:500]
    job["pid"] = None
    job["control"] = None
    _touch(job)
    if status == "done":
        _remove_staging(str(job["job_id"]))
    return True


def _staging_bytes(job: dict) -> int:
    """Somme les fragments du job, jamais ceux d'un autre staging directory."""
    try:
        root = _confined_staging_dir(job)
    except DownloadJobNotFound:
        return 0
    if not os.path.isdir(root):
        return 0
    total = 0
    try:
        for directory, _subdirs, names in os.walk(root):
            for name in names:
                if not (name.endswith(".incomplete") or name.endswith(".partial")):
                    continue
                try:
                    total += os.path.getsize(os.path.join(directory, name))
                except OSError:
                    continue
        if total:
            return total
        relative = Path(str(job.get("filename") or ""))
        if not relative.is_absolute() and ".." not in relative.parts:
            staged_file = Path(root) / relative
            if staged_file.is_file():
                return staged_file.stat().st_size
    except OSError:
        return 0
    return 0


def _reported_progress(job: dict) -> tuple[int, int]:
    """Progression publiee par le worker (``progress.json``) : (recu, total).

    C'est la source TEMPS REEL : la taille du staging, elle, ne progresse que
    par bonds (le telechargement xet ecrit des blocs out-of-order), ce qui
    faisait sauter l'affichage de 0 a 128 Mo puis 384 Mo et faussait la vitesse.
    """
    try:
        root = _confined_staging_dir(job)
    except DownloadJobNotFound:
        return 0, 0
    try:
        with open(os.path.join(root, "progress.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        return max(0, int(data.get("received") or 0)), max(0, int(data.get("total") or 0))
    except (OSError, ValueError, TypeError):
        return 0, 0


def _update_progress_locked(jobs: dict[str, dict], job: dict) -> bool:
    """Met a jour la progression : rapport du worker, puis taille du staging."""
    disk_bytes = _staging_bytes(job)
    reported, reported_total = _reported_progress(job)
    old_received = _as_int(job.get("received"))
    # Le max evite tout retour en arriere si l'un des deux mesureurs retarde.
    measured = max(disk_bytes, reported)
    if measured > old_received:
        job["received"] = measured
    received = _as_int(job.get("received"))
    # Le total annonce par Hugging Face est la taille reelle du fichier : plus
    # fiable que l'estimation du catalogue quand elle existe.
    if reported_total:
        job["total"] = reported_total
    total = _as_int(job.get("total"))
    # Un job termine n'est jamais recalcule : la publication est atomique et le
    # staging a disparu, donc received ne peut que rester a la taille reelle.
    if job.get("status") == "done":
        job["received"] = max(received, disk_bytes)
        job["pct"] = 100.0
    elif total and received:
        job["pct"] = min(100.0, received / total * 100.0)
    else:
        job["pct"] = min(100.0, max(0.0, _as_float(job.get("pct"))))

    now = time.monotonic()
    previous = _PROGRESS_CACHE.get(str(job["job_id"]))
    if previous is not None:
        elapsed = now - previous[1]
        if received > previous[0] and 0 < elapsed <= 5.0:
            # Vitesse lissee : la mesure instantanee est honnete mais nerveuse
            # (le debit varie d'un bloc a l'autre), et une valeur qui saute de 7
            # a 50 Mo/s ne renseigne pas l'utilisateur.
            instant = (received - previous[0]) / elapsed / (1024 ** 2)
            smoothed = _as_float(job.get("speed_mbps"))
            job["speed_mbps"] = round(
                instant if smoothed <= 0 else 0.35 * instant + 0.65 * smoothed, 1)
        else:
            # Rien n'est arrive depuis la mesure precedente : soit le transfert
            # est en pause, soit huggingface_hub verifie le fragment avant de
            # reprendre (reprise d'un gros fichier). Afficher l'ancienne vitesse
            # serait un mensonge : on remet a zero.
            job["speed_mbps"] = 0.0
    _PROGRESS_CACHE[str(job["job_id"])] = (received, now)
    return disk_bytes != old_received


def _refresh_running_status_locked(job: dict) -> None:
    """Traduit les faits disque en statut public lisible.

    Le worker n'ecrit que des fragments : sans cette traduction, un job reste
    « starting » pendant tout le transfert alors que 20 % sont deja arrives.
    """
    if job.get("status") not in _ACTIVE_STATUSES:
        return
    control = job.get("control")
    if control == "cancel":
        job["status"] = "cancelling"
        return
    if control:
        # pause / shutdown en cours : le statut final est pose par
        # _stop_and_finalize, on ne l'anticipe pas.
        return
    if _as_int(job.get("received")) > 0:
        job["status"] = "downloading"
    elif job.get("status") == "starting":
        job["status"] = "resolving"


def _reconcile_job_locked(
    jobs: dict[str, dict], job: dict, *, stale_active: str = "error"
) -> bool:
    """Reconcilie un worker disparu et les fragments ecrits sur disque."""
    job_id = str(job["job_id"])
    before = dict(job)
    _update_progress_locked(jobs, job)
    process = _PROCESSES.get(job_id)
    if process is not None and _process_running(process):
        # Le disque a pu se remplir PENDANT le transfert (autre app, caches) :
        # on arrete proprement au lieu de laisser le worker remplir le volume.
        # Le fragment est conserve, la reprise reste possible apres nettoyage.
        if _free_bytes() < DISK_FLOOR_BYTES:
            _stop_process(process)
            _PROCESSES.pop(job_id, None)
            job["status"] = "error"
            job["error"] = ("Espace disque épuisé pendant le téléchargement : "
                            "transfert arrêté, fragment conservé.")
            job["pid"] = None
            job["control"] = None
            _touch(job)
            _tprint(f"[models] job {job_id} arrete : disque plein")
            return True
        _refresh_running_status_locked(job)
        if _staging_bytes(job) != _as_int(before.get("received")):
            _touch(job)
        return job != before

    if process is not None:
        _PROCESSES.pop(job_id, None)
    result = _read_worker_result(job)
    if result and result.get("status") in ("done", "error"):
        _apply_worker_result_locked(jobs, job, result)
        return True

    control = job.get("control")
    if control == "cancel":
        job["status"] = "cancelled"
        job["pid"] = None
        job["control"] = None
        job["error"] = None
        _touch(job)
        return True
    if control in ("pause", "shutdown"):
        job["status"] = "paused"
        job["pid"] = None
        job["control"] = None
        _touch(job)
        return True

    if job.get("status") in _ACTIVE_STATUSES:
        # Un backend-redemarre n'a plus de processus fiable. On preserve le
        # fragment et on laisse une action explicite reprendre le job.
        job["status"] = "paused" if stale_active == "paused" else "error"
        if stale_active != "paused":
            job["error"] = "Le processus de téléchargement s'est arrêté sans résultat."
        job["pid"] = None
        _touch(job)
    elif job != before:
        _touch(job)
    return job != before


def _reconcile_all_locked(*, stale_active: str = "error") -> bool:
    jobs = _load_jobs_locked()
    changed = False
    for job in list(jobs.values()):
        changed = _reconcile_job_locked(jobs, job, stale_active=stale_active) or changed
    if changed:
        _write_jobs_locked(jobs)
    return changed


def _check_model_id(model_id: str) -> dict:
    """Valide un model_id contre le catalogue (anti-traversee via manifest)."""
    value = str(model_id or "")
    return _entry(value)


def _manifest_model_ids() -> list[str]:
    """Ids des modeles dont le fichier est present sur disque."""
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            manifest = _read_manifest_unlocked()
    return sorted(
        str(model_id) for model_id, record in manifest.items()
        if isinstance(record, dict) and record.get("file")
        and os.path.isfile(str(record["file"]))
    )


def _realign_selection_after_delete(model_id: str) -> None:
    """Un modele supprime ne peut pas rester le choix courant.

    Le choix est une source unique : le laisser pointer sur un fichier disparu
    affichait un modele « selectionne » inexistant, un moteur impossible a
    charger et une app « non configuree ». On bascule sur un autre modele
    telecharge s'il en reste, sinon sur le fournisseur externe par defaut.
    """
    from services import llm

    selection = llm.active_selection()
    if selection.get("kind") != "embedded" or selection.get("model") != model_id:
        return
    remaining = _manifest_model_ids()
    if remaining:
        _tprint(f"[models] choix bascule sur {remaining[0]!r} (modele supprime)")
        llm.set_selection("embedded", model=remaining[0])
    else:
        _tprint("[models] plus de modele local : retour au fournisseur par defaut")
        llm.set_selection(llm.DEFAULT_KIND)


def delete_downloaded(model_id: str) -> str:
    """Supprime un modele telecharge : serveur arrete, .gguf purge, manifeste nettoye.

    Les jobs termines du meme modele restent en historique ``done`` mais
    pointent vers un fichier absent : ``list_downloaded`` ne liste que le
    manifeste, le telechargement reste relancable via ``start_download``.
    """
    entry = _check_model_id(model_id)
    with _SERVER_LOCK:
        if _SERVER and _SERVER.get("model_id") == model_id:
            _stop_server_locked()
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            manifest = _read_manifest_unlocked()
            record = manifest.get(model_id) or {}
            removed = manifest.pop(model_id, None) is not None
            path = _manifest_path()
            temporary = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(manifest, handle, ensure_ascii=False, indent=1)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
    deleted_bytes = 0
    candidates = []
    stored = record.get("file") if isinstance(record, dict) else None
    if stored:
        candidates.append(stored)
    expected = str(entry.get("file") or "")
    if expected:
        candidates.append(os.path.join(models_dir(), os.path.basename(expected)))
    seen = set()
    for candidate in candidates:
        candidate = os.path.abspath(candidate)
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate == os.path.abspath(models_dir()):
            continue
        if os.path.dirname(candidate) != os.path.abspath(models_dir()):
            continue
        try:
            deleted_bytes += os.path.getsize(candidate)
            os.unlink(candidate)
        except OSError:
            pass
    if not removed and not deleted_bytes:
        raise ValueError(f"Modele non telecharge : {model_id!r}")
    _realign_selection_after_delete(model_id)
    return json.dumps({"model_id": model_id, "deleted_bytes": deleted_bytes},
                      ensure_ascii=False)


DISK_FLOOR_BYTES = 300 * 1024 ** 2  # marge : on ne remplit jamais le disque a fond


def _free_bytes() -> int:
    """Espace libre du volume des modeles (0 si illisible : on refuse alors)."""
    try:
        return shutil.disk_usage(models_dir()).free
    except OSError:
        return 0


def _same_filesystem(first: str, second: str) -> bool:
    """True si deux chemins vivent sur le meme systeme de fichiers."""
    try:
        os.makedirs(first, exist_ok=True)
        os.makedirs(second, exist_ok=True)
        return os.stat(first).st_dev == os.stat(second).st_dev
    except OSError:
        # Prudence : on suppose le renommage possible (cas normal).
        return True


def _ensure_space(entry: dict, already_bytes: int = 0) -> None:
    """Refuse tout telechargement qui ne tiendrait pas sur le disque.

    Sans taille connue, on refuse : c'est la seule facon de garantir qu'un
    transfert ne remplira jamais le disque (le catalogue et le Hub fournissent
    toujours une taille).

    Args:
        entry: Entree du modele (``size_gb``).
        already_bytes: Fragment deja sur le disque (reprise) : seule la partie
            manquante doit tenir, sinon un transfert avance a 90 % deviendrait
            impossible a finir.

    Raises:
        ValueError: Taille inconnue, ou espace insuffisant (message chiffre).
    """
    size_bytes = int(float(entry.get("size_gb", 0) or 0) * 1024 ** 3)
    free = _free_bytes()
    if not size_bytes:
        raise ValueError(
            "Taille du modèle inconnue : téléchargement refusé "
            "(impossible de vérifier l'espace disque)."
        )
    needed = max(0, size_bytes - max(0, int(already_bytes)))
    # Le staging vit DANS le repertoire des modeles : a la publication le
    # fichier est simplement renomme, donc son empreinte ne double jamais. Le
    # facteur x2 ne vaut que pour le repli inter-volumes (`shutil.copy2`).
    factor = 1.0 if _same_filesystem(_downloads_dir(), models_dir()) else 2.0
    required = int(needed * factor) + DISK_FLOOR_BYTES
    if free < required:
        raise ValueError(
            f"Espace disque insuffisant : {free / 1024**3:.1f} Go libres pour "
            f"~{needed / 1024**3:.1f} Go à télécharger "
            f"(+ {DISK_FLOOR_BYTES // 1024**2} Mo de marge)."
        )


def start_download(model_id: str = "", entry: dict | None = None) -> str:
    """Cree un job durable et lance un worker, sans bloquer sur le reseau.

    Args:
        model_id: Id du catalogue cure.
        entry: Entree explicite (modele choisi sur Hugging Face) ; prioritaire
            sur le catalogue, ce qui permet de telecharger un modele qui n'y
            figure pas.

    Un job ``paused`` ou ``error`` du meme modele est relance dans SON staging :
    « Reessayer » reprend donc le fragment au lieu d'empiler des staging
    orphelins et de retelecharger depuis zero.
    """
    entry = entry or _entry(model_id)
    model_id = str(entry.get("id") or model_id)
    os.makedirs(models_dir(), exist_ok=True)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        for existing in jobs.values():
            if (existing.get("model_id") == model_id
                    and existing.get("status") in _ACTIVE_STATUSES):
                raise DownloadConflict(
                    f"Un telechargement de {model_id!r} est deja en cours "
                    f"(job_id={existing.get('job_id')})."
                )
        resumable = sorted(
            (
                job for job in jobs.values()
                if job.get("model_id") == model_id
                and job.get("status") in ("paused", "error")
            ),
            key=lambda item: (str(item.get("created_at", "")), str(item.get("job_id", ""))),
            reverse=True,
        )
        if resumable:
            job = resumable[0]
            # Les staging des anciens retries becomes inutiles : un seul
            # fragment conserv par modele.
            for stale in resumable[1:]:
                _remove_staging(str(stale["job_id"]))
            _ensure_space(entry, _as_int(job.get("received")))
            if not _launch_job_locked(jobs, job):
                raise RuntimeError(job.get("error") or "Worker de telechargement indisponible")
            return json.dumps({
                "job_id": str(job["job_id"]),
                "model_id": model_id,
                "resumed": True,
                "job": _public_job(dict(job)),
            }, ensure_ascii=False)
        _ensure_space(entry)
    # Nouvelle tentative : le verrou est reacquis, donc un job venu au monde
    # entre-temps (requete concurrente) est detecte ici avant de creer un
    # second staging pour le meme modele.
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        for existing in jobs.values():
            if (existing.get("model_id") == model_id
                    and existing.get("status") in (_ACTIVE_STATUSES | {"paused"})):
                raise DownloadConflict(
                    f"Un telechargement de {model_id!r} est deja en cours ou en pause "
                    f"(job_id={existing.get('job_id')})."
                )
        job_id = _next_job_id(jobs)
        staging_dir = _job_staging_dir(job_id)
        os.makedirs(staging_dir, exist_ok=True)
        total = int(float(entry.get("size_gb", 0) or 0) * 1024 ** 3)
        job = {
            "job_id": job_id,
            "model_id": model_id,
            "status": "starting",
            "received": _staging_bytes({"staging_dir": staging_dir, "filename": ""}),
            "total": total,
            "pct": 0.0,
            "speed_mbps": 0.0,
            "error": None,
            "file": None,
            "filename": str(entry.get("file") or ""),
            "repo_id": str(entry.get("repo") or ""),
            "pattern": str(entry.get("pattern") or ""),
            "staging_dir": staging_dir,
            "entry": dict(entry),
            "created_at": _now(),
            "updated_at": _now(),
            "pid": None,
            "control": None,
        }
        jobs[job_id] = job
        _write_jobs_locked(jobs)
        if not _launch_job_locked(jobs, job):
            raise RuntimeError(job.get("error") or "Worker de telechargement indisponible")
    return json.dumps({"job_id": job_id, "model_id": model_id}, ensure_ascii=False)


def download_snapshot(job_id: str) -> str:
    """Retourne l'etat courant et reconcile les workers disparus."""
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        if _reconcile_job_locked(jobs, job, stale_active="error"):
            _write_jobs_locked(jobs)
        snapshot = _public_job(dict(job))
    return json.dumps(snapshot, ensure_ascii=False)


def list_download_jobs() -> str:
    """Liste les jobs persistants, du plus recent au plus ancien."""
    with _JOBS_LOCK:
        _reconcile_all_locked(stale_active="error")
        jobs = _load_jobs_locked()
        ordered = sorted(
            jobs.values(),
            key=lambda item: (str(item.get("created_at", "")), str(item.get("job_id", ""))),
            reverse=True,
        )
        return json.dumps({"jobs": [_public_job(job) for job in ordered]}, ensure_ascii=False)


def download_state(job_id: str) -> str:
    """Alias explicite pour les clients qui ne consomment pas SSE."""
    return download_snapshot(job_id)


def _remove_staging(job_id: str) -> None:
    path = os.path.join(_downloads_dir(), "staging", _check_job_id(job_id))
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except OSError:
        # Le job reste annule meme si un antivirus tient un fichier ouvert.
        _tprint(f"[models] staging non supprime : {path}")


def _stop_and_finalize(job_id: str, final_status: str, *, remove: bool) -> dict:
    """Termine un worker puis publie l'etat final sous le verrou du registre."""
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(str(job_id))
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        process = _PROCESSES.get(str(job_id))
        if process is not None:
            job["control"] = "cancel" if final_status == "cancelled" else "pause"
            _touch(job)
            _write_jobs_locked(jobs)
        else:
            job["control"] = "cancel" if final_status == "cancelled" else "pause"
        if process is not None:
            stopped = _stop_process(process)
        else:
            stopped = True
    if not stopped:
        with _JOBS_LOCK:
            jobs = _load_jobs_locked()
            if str(job_id) in jobs:
                jobs[str(job_id)]["status"] = "error"
                jobs[str(job_id)]["error"] = "Le processus worker ne peut pas être arrêté."
                jobs[str(job_id)]["control"] = None
                _touch(jobs[str(job_id)])
                _write_jobs_locked(jobs)
        raise RuntimeError("Le processus worker ne peut pas être arrêté.")
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(str(job_id))
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        _PROCESSES.pop(str(job_id), None)
        result = _read_worker_result(job)
        # Si le worker a fini juste avant le signal, ne pas transformer un
        # fichier valide en telechargement annule.
        if result.get("status") == "done":
            _apply_worker_result_locked(jobs, job, result)
        else:
            job["status"] = final_status
            job["pid"] = None
            job["control"] = None
            job["error"] = None if final_status != "error" else job.get("error")
            _update_progress_locked(jobs, job)
            _touch(job)
        if remove and job.get("status") == "cancelled":
            _remove_staging(str(job_id))
        try:
            os.unlink(_job_result_path(str(job_id)))
        except OSError:
            pass
        _write_jobs_locked(jobs)
        return _public_job(dict(job))


def pause_download(job_id: str) -> str:
    """Met le job en pause ; l'operation est idempotente."""
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        changed = _reconcile_job_locked(jobs, job, stale_active="paused")
        if changed:
            _write_jobs_locked(jobs)
        if job.get("status") == "paused" and not job.get("control"):
            return json.dumps(_public_job(dict(job)), ensure_ascii=False)
        if job.get("status") not in _ACTIVE_STATUSES or job.get("control"):
            raise DownloadConflict(
                f"Le job {job_id!r} ne peut pas être mis en pause depuis l'état "
                f"{job.get('status')!r}."
            )
    return json.dumps(_stop_and_finalize(job_id, "paused", remove=False), ensure_ascii=False)


def resume_download(job_id: str) -> str:
    """Relance un job paused ou error dans le meme staging (.incomplete conserve)."""
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        changed = _reconcile_job_locked(jobs, job, stale_active="paused")
        if changed:
            _write_jobs_locked(jobs)
        if job.get("status") not in ("paused", "error") or job.get("control"):
            raise DownloadConflict(
                f"Le job {job_id!r} ne peut pas être repris depuis l'état "
                f"{job.get('status')!r}."
            )
        _ensure_space(job.get("entry") or _entry(str(job.get("model_id"))),
                      _as_int(job.get("received")))
        if not _launch_job_locked(jobs, job):
            raise RuntimeError(job.get("error") or "Worker de telechargement indisponible")
        return json.dumps(_public_job(dict(job)), ensure_ascii=False)


def cancel_download(job_id: str) -> str:
    """Annule un job et supprime son staging ; l'operation est idempotente."""
    job_id = _check_job_id(job_id)
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        job = jobs.get(job_id)
        if job is None:
            raise DownloadJobNotFound(f"Job de telechargement inconnu : {job_id!r}")
        changed = _reconcile_job_locked(jobs, job, stale_active="paused")
        if changed:
            _write_jobs_locked(jobs)
        if job.get("status") == "cancelled":
            return json.dumps(_public_job(dict(job)), ensure_ascii=False)
        can_cancel = job.get("status") in (_ACTIVE_STATUSES | {"error"}) or (
            job.get("status") == "paused" and not job.get("control")
        )
        if not can_cancel or job.get("control"):
            raise DownloadConflict(
                f"Le job {job_id!r} ne peut pas être annulé depuis l'état "
                f"{job.get('status')!r}."
            )
    return json.dumps(_stop_and_finalize(job_id, "cancelled", remove=True), ensure_ascii=False)


def reconcile_download_jobs() -> list[dict]:
    """Recharge les jobs au boot : les processus orphelins sont en erreur."""
    _migrate_legacy_models()
    with _JOBS_LOCK:
        _reconcile_all_locked(stale_active="error")
        return [_public_job(dict(job)) for job in _load_jobs_locked().values()]


def shutdown_downloads() -> str:
    """Arrete les workers et preserve tous les fragments pour la reprise."""
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        processes = []
        for job in jobs.values():
            if job.get("status") in _ACTIVE_STATUSES:
                job["control"] = "shutdown"
                job["status"] = "paused"
                job["pid"] = job.get("pid")
                _touch(job)
                process = _PROCESSES.get(str(job["job_id"]))
                if process is not None:
                    processes.append((str(job["job_id"]), process))
        _write_jobs_locked(jobs)
    stopped = 0
    for _job_id, process in processes:
        if _stop_process(process):
            stopped += 1
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
        for job in jobs.values():
            if job.get("control") == "shutdown":
                _PROCESSES.pop(str(job["job_id"]), None)
                result = _read_worker_result(job)
                if result.get("status") == "done":
                    _apply_worker_result_locked(jobs, job, result)
                else:
                    job["status"] = "paused"
                    job["pid"] = None
                    job["control"] = None
                    _update_progress_locked(jobs, job)
                    _touch(job)
                try:
                    os.unlink(_job_result_path(str(job["job_id"])))
                except OSError:
                    pass
        _write_jobs_locked(jobs)
    return json.dumps({"stopped": stopped}, ensure_ascii=False)


def _disk_bytes(filename: str = "", staging_dir: str | None = None) -> int:
    """Compatibilite outil : taille des fragments d'un staging precise."""
    if staging_dir:
        return _staging_bytes({"staging_dir": staging_dir, "filename": ""})
    if not filename:
        return 0
    return _staging_bytes({"staging_dir": os.path.dirname(filename), "filename": os.path.basename(filename)})


# ------------------------------------------------------------------- serveur d'inference
# llm.py (provider) appelle ces fonctions ; le serveur est un processus
# llama-server enfant, lazy (RAM), tue proprement via stop_embedded().
_SERVER: dict | None = None
_SERVER_PROC: subprocess.Popen | None = None
# `ensure_embedded` vérifie l'état du serveur tout en tenant ce verrou ; un
# verrou réentrant évite le deadlock entre `_SERVER_LOCK` et `embedded_running`.
_SERVER_LOCK = threading.RLock()

# Chargement en tache de fond : une seule file, la cible la plus recente gagne.
_LOAD_LOCK = threading.Lock()
_WANTED_MODEL: str | None = None
_LOADING_MODEL: str | None = None
_LOAD_ERROR: str | None = None
# Modele concerne par la derniere erreur de chargement (pour ne pas afficher une
# erreur devenue hors sujet apres un changement de selection).
_LOAD_ERROR_MODEL: str | None = None


def _clear_load_error() -> None:
    global _LOAD_ERROR, _LOAD_ERROR_MODEL
    with _LOAD_LOCK:
        _LOAD_ERROR = None
        _LOAD_ERROR_MODEL = None


def _selected_model() -> str:
    """Modele local choisi ('' si le choix n'est pas local)."""
    try:
        from services import llm
        selection = llm.active_selection()
        return str(selection.get("model") or "") if selection.get("kind") == "embedded" else ""
    except Exception:
        return ""


def _download_in_flight(model_id: str) -> bool:
    """True si ce modele est en cours de telechargement (ou en pause).

    Un modele choisi dont le fichier n'est pas encore publie ne doit pas etre
    traite comme une erreur : on attend la fin du transfert.
    """
    with _JOBS_LOCK:
        jobs = _load_jobs_locked()
    return any(
        str(job.get("model_id")) == model_id
        and str(job.get("status")) in (_ACTIVE_STATUSES | {"paused"})
        for job in jobs.values()
    )


def _selected_pending_download() -> bool:
    """True si le modele choisi n'est pas encore publie (telechargement en cours)."""
    try:
        from services import llm
        selection = llm.active_selection()
        model_id = str(selection.get("model") or "")
        if selection.get("kind") != "embedded" or not model_id:
            return False
        if is_downloaded(model_id):
            return False
        return _download_in_flight(model_id)
    except Exception:
        return False


def _maybe_load_selected(model_id: str) -> None:
    """Charge le modele qui vient d'etre publie s'il est celui qui est choisi."""
    from services import llm

    selection = llm.active_selection()
    if selection.get("kind") == "embedded" and selection.get("model") == model_id:
        _tprint(f"[models] modele choisi publie : chargement de {model_id!r}")
        switch_embedded(model_id)


def embedded_status() -> dict:
    """Etat du moteur local, lisible PENDANT un chargement.

    ``state`` : ``idle`` (rien de charge) · ``loading`` (process lance, API pas
    encore prete) · ``ready`` (l'API repond) · ``error`` (dernier chargement
    echoue). L'UI s'en sert pour afficher une progression reelle.

    ``llama-server`` ouvre son port AVANT d'avoir charge le modele : ni le
    connect TCP ni ``model_id`` ne prouvent la disponibilite. On sonde son API
    (503 tant que le chargement n'est pas fini), et une disponibilite acquise
    est conservee — sinon l'etat oscillerait entre ``loading`` et ``ready``
    pendant que le modele charge.
    """
    with _SERVER_LOCK:
        state = dict(_SERVER) if _SERVER else {}
    with _LOAD_LOCK:
        loading_model = _LOADING_MODEL
        error = _LOAD_ERROR
        error_model = _LOAD_ERROR_MODEL
    if not state:
        if error:
            # Une erreur ne vaut que pour le modele alors choisi : si la
            # selection a change depuis, elle n'a plus de sens.
            selection = None
            try:
                from services import llm
                selection = llm.active_selection().get("model")
            except Exception:
                selection = None
            if error_model in (None, selection):
                return {"state": "error", "error": error, "model_id": loading_model}
        # Rien de charge : soit le moteur est arrete, soit le modele choisi est
        # encore en telechargement (l'UI le dit alors au lieu d'afficher un
        # echec de chargement).
        if _selected_pending_download():
            return {"state": "idle", "waiting_for_download": True,
                    "model_id": loading_model}
        if error and error_model is not None and is_downloaded(error_model) \
                and error_model == _selected_model():
            # L'erreur parlait d'un modele absent : il est la desormais, elle est
            # obsolete (sinon l'UI affiche une erreur rouge qui ne s'applique
            # plus, alors que le panneau, lui, est a jour).
            _clear_load_error()
        return {"state": "idle"}
    ready = bool(state.get("ready"))
    if not ready:
        try:
            ready = _http_ready(int(state["port"]))
        except (KeyError, TypeError, ValueError):
            ready = False
        if ready:
            with _SERVER_LOCK:
                if _SERVER is not None:
                    _SERVER["ready"] = True
    return {
        "state": "ready" if ready else "loading",
        "model_id": state.get("model_id"),
        "pid": state.get("pid"),
        "port": state.get("port"),
        "since": state.get("since"),
    }


def switch_embedded(model_id: str) -> str:
    """Aligne le moteur sur ``model_id`` SANS bloquer l'appelant.

    Le moteur ne sert jamais un modele qui n'est pas la selection courante : un
    serveur qui sert un autre modele est arrete, puis le chargement se poursuit
    en tache de fond. Retourne l'etat courant (``embedded_status``), a suivre
    ensuite par polling : ``/ai/embedded``.
    """
    global _WANTED_MODEL, _LOAD_ERROR, _LOAD_ERROR_MODEL
    model_id = str(model_id or "")
    if not model_id:
        return json.dumps(embedded_status(), ensure_ascii=False)
    with _LOAD_LOCK:
        _WANTED_MODEL = model_id
        _LOAD_ERROR = None
        _LOAD_ERROR_MODEL = None
        already = _LOADING_MODEL == model_id
    if not already and not (embedded_state().get("model_id") == model_id
                            and embedded_ready()):
        threading.Thread(target=_load_loop, daemon=True, name="llama-load").start()
    return json.dumps(embedded_status(), ensure_ascii=False)


def _load_loop() -> None:
    """Charge la cible courante ; une cible plus recente prend le relais."""
    global _LOADING_MODEL, _LOAD_ERROR, _LOAD_ERROR_MODEL
    while True:
        with _LOAD_LOCK:
            target = _WANTED_MODEL
            if not target or _LOADING_MODEL == target:
                return
            _LOADING_MODEL = target
            _LOAD_ERROR = None
            _LOAD_ERROR_MODEL = None
        try:
            if embedded_state().get("model_id") == target and embedded_ready():
                continue  # deja pret : rien a faire, on reverifie la cible
            ensure_embedded(target)
        except Exception as exc:
            # Modele choisi mais pas encore publie : le telechargement est en
            # cours (ou en pause). Ce n'est pas un echec de chargement — la
            # publication declenchera le chargement — donc on n'efface pas
            # l'erreur precedente et on n'en pose pas de nouvelle.
            if _download_in_flight(target):
                _tprint(f"[models] {target!r} en telechargement : chargement en attente")
                return
            _tprint(f"[models] chargement {target!r} echoue : {exc}")
            with _LOAD_LOCK:
                _LOAD_ERROR = f"{type(exc).__name__}: {exc}"[:300]
                _LOAD_ERROR_MODEL = target
        finally:
            with _LOAD_LOCK:
                if _LOADING_MODEL == target:
                    _LOADING_MODEL = None
                pending = bool(_WANTED_MODEL and _WANTED_MODEL != target)
            if not pending:
                return


def embedded_state() -> dict:
    """Etat courant du serveur local : {pid, port, model_id, since} ou {} vide."""
    with _SERVER_LOCK:
        return dict(_SERVER) if _SERVER else {}


def embedded_running() -> bool:
    """True si le serveur tourne ET repond (utilise par llm.is_configured)."""
    return embedded_ready()


def embedded_ready() -> bool:
    """True si l'API du serveur repond VRAIMENT (pas seulement port ouvert)."""
    return embedded_status().get("state") == "ready"


def _llama_server_bin() -> str:
    """Chemin du binaire llama-server : bundle desktop, sinon PATH (dev).

    L'app desktop fournit NEUROBEATS_LLAMA_SERVER (extraResources/runtime) ;
    en dev on accepte un llama-server du PATH pour tester sans repackager.
    """
    env = os.environ.get("NEUROBEATS_LLAMA_SERVER")
    if env and os.path.isfile(env):
        return env
    which = shutil.which("llama-server")
    if which:
        return which
    raise RuntimeError(
        "llama-server introuvable : lancez NeuroBeats desktop, ou installez "
        "llama.cpp (brew install llama.cpp) pour le mode developpement."
    )


def _reserve_port() -> tuple[socket.socket, int]:
    """Reserve un port local et garde le socket ouvert contre le TOCTOU.

    Le socket reste tenu jusqu'au spawn de llama-server : aucun autre
    processus ne peut prendre le port entre-temps. En cas d'echec du spawn,
    l'appelant ferme le socket.
    """
    reserved = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    reserved.bind(("127.0.0.1", 0))
    return reserved, reserved.getsockname()[1]


def _free_port() -> int:
    reserved, port = _reserve_port()
    reserved.close()
    return port


def _http_ready(port: int) -> bool:
    """Attendre que l'API OpenAI de llama-server réponde, pas seulement son port."""
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/models",
        headers={"Connection": "close"},
    )
    try:
        with urllib.request.urlopen(request, timeout=1.0) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def _model_path(model_id: str) -> str:
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            manifest = _read_manifest_unlocked()
    entry = manifest.get(model_id)
    if not entry or not entry.get("file") or not os.path.isfile(entry["file"]):
        raise RuntimeError(
            f"Modele {model_id!r} non telecharge. Lancez d'abord le telechargement."
        )
    return entry["file"]


def _record_manifest(model_id: str, file: str, entry: dict):
    """Met a jour le manifeste sous lock et ecrit par remplacement atomique.

    On conserve aussi `repo`/`pattern`/`ctx` : pour un modele telecharge hors
    catalogue, le manifeste devient la seule source de son entree (relue par
    `_entry`) — sans quoi la suppression et le contexte d'inference seraient
    perdus au redemarrage.
    """
    os.makedirs(models_dir(), exist_ok=True)
    with _MANIFEST_LOCK:
        with _exclusive_file_lock(_manifest_path()):
            manifest = _read_manifest_unlocked()
            try:
                size = os.path.getsize(file)
            except OSError:
                size = 0
            previous = manifest.get(model_id) or {}
            manifest[model_id] = {
                "model_id": model_id, "name": entry.get("name") or previous.get("name", model_id),
                "file": file, "size_bytes": size,
                "repo": entry.get("repo") or previous.get("repo", ""),
                "pattern": entry.get("pattern") or previous.get("pattern", ""),
                "ctx": int(entry.get("ctx") or previous.get("ctx") or 8192),
                "downloaded_at": _now(),
            }
            path = _manifest_path()
            temporary = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(manifest, handle, ensure_ascii=False, indent=1)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)


def _llama_log_path(model_id: str) -> str:
    """Fichier de logs du serveur (diagnostic quand llama-server quitte)."""
    os.makedirs(models_dir(), exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in model_id)[:32]
    return os.path.join(models_dir(), f"llama-{safe or 'server'}.log")


def _gpu_layers_arg() -> list[str]:
    """Argument ``--n-gpu-layers`` : *rien* par defaut.

    Ce llama.cpp a un mode ``auto`` par defaut : il repartit lui-meme les couches
    selon la VRAM reellement libre. Le forcer est contre-productif — l'auto-fit
    est alors desactive, ce qui peut saturer la memoire du GPU et fait chuter le
    prefill (mesure : 1143 t/s en auto contre 60 t/s avec « tout en VRAM »). On ne
    transmet donc une valeur que si l'utilisateur la demande explicitement.
    """
    value = (os.environ.get("NEUROBEATS_GPU_LAYERS") or "").strip()
    return ["--n-gpu-layers", value] if value else []


def _embedded_cmd(llama_bin: str, model_id: str, model_path: str, port: int) -> list[str]:
    """Ligne de commande llama-server : ctx du catalogue, GPU reparti par llama.cpp."""
    try:
        ctx = max(1024, int((_entry(model_id) or {}).get("ctx") or 8192))
    except ValueError:
        ctx = 8192
    return [
        llama_bin, "-m", model_path, "--host", "127.0.0.1",
        "--port", str(port), "-c", str(ctx), "--parallel", "1",
        *_gpu_layers_arg(),
        "--no-webui", "--alias", model_id,
    ]


def ensure_embedded(model_id: str) -> str:
    """Demarre llama-server sur ce modele (relance si le modele change).

    Le chargement prend ~10-60 s selon la machine : l'API dediee
    (`/ai/embedded/start`) et le chargement de fond l'appellent en direct.
    INVARIANT : le moteur ne sert jamais un modele qui n'est pas la selection
    courante (une seule voie d'ecriture du choix : `llm.set_selection`).
    """
    global _SERVER, _SERVER_PROC
    from services import llm

    selection = llm.active_selection()
    if selection.get("kind") != "embedded" or selection.get("model") != model_id:
        raise RuntimeError(
            "Le moteur ne sert que le modèle sélectionné "
            f"({selection.get('model') or selection.get('kind')!r}), pas {model_id!r}."
        )
    model_path = _model_path(model_id)
    with _SERVER_LOCK:
        if _SERVER and _SERVER.get("model_id") == model_id and embedded_ready():
            return json.dumps(_SERVER, ensure_ascii=False)
        stopped = _stop_server_locked()
        if stopped:
            _tprint("[models] serveur precedent arrete (changement de modele)")
            # llama.cpp repartit ses couches d'apres la VRAM libre AU MOMENT du
            # chargement : relancer aussitot lui fait voir la memoire du serveur
            # qu'on vient d'arreter (partiellement liberee), et il choisit alors
            # un offload partiel qu'il garde (mesure : 1,2 Go au lieu de 6,5 Go,
            # 9 t/s au lieu de 39). On laisse le pilote recuperer.
            time.sleep(1.5)

        proc = None
        last_error: Exception | None = None
        llama_bin = _llama_server_bin()
        for _attempt in range(3):
            reserved, port = _reserve_port()
            try:
                log_handle = open(_llama_log_path(model_id), "a", encoding="utf-8")
            except OSError:
                log_handle = None
            try:
                proc = subprocess.Popen(
                    _embedded_cmd(llama_bin, model_id, model_path, port),
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle or subprocess.DEVNULL,
                    stderr=subprocess.STDOUT,
                    close_fds=True,
                    **sans_fenetre_console(),
                )
            except OSError as exc:
                last_error = exc
                if log_handle is not None:
                    log_handle.close()
            finally:
                reserved.close()
            if proc is not None:
                break
            time.sleep(0.2)
        if proc is None:
            raise RuntimeError(
                f"llama-server ne demarre pas : {last_error}")
        _SERVER = {"pid": proc.pid, "port": port, "model_id": model_id,
                   "since": time.strftime("%Y-%m-%dT%H:%M:%S")}
        _SERVER_PROC = proc
    # Attente du /v1/models (hors lock : le polling ne bloque pas d'autres demandes).
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            with _SERVER_LOCK:
                _SERVER = None
                _SERVER_PROC = None
            raise RuntimeError(
                "llama-server a quitte au chargement "
                f"(voir {_llama_log_path(model_id)}).")
        if _http_ready(port):
            return json.dumps(_SERVER, ensure_ascii=False)
        time.sleep(0.5)
    stop_embedded()
    raise RuntimeError("llama-server ne repond pas apres 90 s.")


def stop_embedded() -> str:
    """Arrete llama-server s'il tourne (safe en autonomie)."""
    with _SERVER_LOCK:
        stopped = _stop_server_locked()
        return json.dumps({"stopped": stopped}, ensure_ascii=False)


def _stop_server_locked() -> bool:
    """Arrete le serveur ; a appeler avec _SERVER_LOCK tenu. Retourne True si arrete."""
    global _SERVER, _SERVER_PROC
    if not _SERVER and _SERVER_PROC is None:
        return False
    proc, _SERVER_PROC = _SERVER_PROC, None
    _SERVER = None
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        except Exception:
            pass
    return True
