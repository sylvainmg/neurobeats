"""Processus worker des téléchargements de modèles GGUF.

Le worker est volontairement séparé du service HTTP : une interruption doit
pouvoir tuer et réappliquer le processus qui écrit le fichier sans toucher à
l'état du backend. Le dossier ``staging_dir`` et son fichier de résultat sont
donc des artefacts durables, pas des canaux IPC en mémoire.
"""
from __future__ import annotations

import inspect
import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any


def _write_json(path: str, value: dict[str, Any]) -> None:
    """Écrit un résultat JSON atomiquement pour tolerate un arrêt brutal."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.tmp"
    )
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, destination)


def _resolve_filename(payload: dict[str, Any]) -> str:
    """Résout le nom GGUF sans exposer une résolution au thread HTTP."""
    repo_id = str(payload["repo_id"])
    exact = str(payload.get("filename") or "")
    pattern = str(payload.get("pattern") or "")

    # Les entrées curées avec un nom exact évitent une requête de listing.
    if exact:
        return exact

    from huggingface_hub import list_repo_files

    candidates = [
        name for name in list_repo_files(repo_id)
        if name.endswith(".gguf")
    ]
    if pattern:
        for name in candidates:
            if pattern in name:
                return name
    if candidates:
        return candidates[0]
    raise RuntimeError("Impossible de résoudre le fichier GGUF (réseau requis).")


def _progress_reporter(staging_dir: str):
    """Classe tqdm qui publie l'avancement REEL du transfert pour le parent.

    La taille du staging ne suffit pas : le telechargement xet (ou http avec
    ecritures par blocs) fait progresser la taille du fichier par bonds, alors
    que huggingface_hub connait exactement le nombre d'octets recus. On publie
    donc sa progression dans ``progress.json`` (throttle), que le service lit
    pour afficher une avancee fluide et une vitesse honnete.

    La barre est desactivee (aucune sortie terminal), mais l'objet reste utilise
    par la bibliotheque pour tous les transferts, y compris xet.
    """
    from tqdm.auto import tqdm as _tqdm

    path = os.path.join(staging_dir, "progress.json")
    lock = threading.Lock()
    state = {"at": 0.0}

    class Reporter(_tqdm):
        def __init__(self, *args, **kwargs):
            kwargs["disable"] = True
            super().__init__(*args, **kwargs)
            # Compteur propre : avec `disable=True`, tqdm court-circuite son
            # propre `self.n`, donc on ne peut pas s'y fier.
            self._received = 0
            self._publish()

        def update(self, n=1):
            try:
                self._received += int(n or 0)
            except (TypeError, ValueError):
                pass
            super().update(n)
            self._publish()

        def close(self):
            # Fin de transfert (ou pause) : on publie la valeur finale sans
            # attendre le throttle, sinon le dernier palier serait perdu.
            super().close()
            self._publish(force=True)

        def _publish(self, force: bool = False):
            now = time.monotonic()
            with lock:
                if not force and now - state["at"] < 0.4:
                    return
                state["at"] = now
            temporary = f"{path}.{os.getpid()}.tmp"
            try:
                with open(temporary, "w", encoding="utf-8") as handle:
                    json.dump({"received": self._received,
                               "total": int(self.total or 0)}, handle)
                os.replace(temporary, path)
            except OSError:
                pass

    return Reporter


def _download_kwargs(download, payload: dict[str, Any]) -> dict[str, Any]:
    """Construit uniquement les kwargs acceptés par la version installée."""
    kwargs: dict[str, Any] = {
        "repo_id": payload["repo_id"],
        "filename": payload["filename"],
        "local_dir": payload["staging_dir"],
    }
    try:
        parameters = inspect.signature(download).parameters
    except (TypeError, ValueError):
        parameters = {}
    if "force_download" in parameters:
        kwargs["force_download"] = False
    # `tqdm_class` n'existe pas dans les versions anciennes : on l'ajoute quand
    # elle est disponible, pour une progression en temps reel.
    if "tqdm_class" in parameters:
        kwargs["tqdm_class"] = _progress_reporter(str(payload["staging_dir"]))
    return kwargs


def _safe_relative(filename: str) -> Path:
    relative = Path(filename)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"Chemin de fichier HF invalide : {filename!r}")
    return relative


def _publish_download(downloaded: str, payload: dict[str, Any]) -> str:
    """Déplace le fichier fini hors du staging, atomiquement si possible."""
    relative = _safe_relative(str(payload["filename"]))
    source = Path(downloaded)
    if not source.is_absolute():
        source = Path(payload["staging_dir"]) / source
    if not source.is_file():
        raise RuntimeError(f"Le worker n'a pas produit le fichier attendu : {source}")

    destination = Path(payload["models_dir"]) / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        if source.resolve() == destination.resolve():
            return str(destination)
        os.replace(source, destination)
    except OSError:
        # Un staging et le répertoire des modèles peuvent être sur des volumes
        # différents. Le fallback reste sûr : le fichier final n'est publié
        # qu'après la copie complète.
        shutil.copy2(source, destination)
    return str(destination)


def run_download_worker(
    payload: dict[str, Any], download_fn: Any | None = None
) -> None:
    """Télécharge un job et écrit son résultat durable.

    Le processus ne reçoit aucun callback d'annulation. Le parent termine ce
    processus pour pause/annulation ; le dossier et ses éventuels fichiers
    ``.incomplete`` sont alors laissés en place pour la reprise.

    ``download_fn`` est injectable uniquement pour les tests locaux ; le
    processus réel utilise la fonction installée de ``huggingface_hub``.
    """
    result_path = str(payload["result_path"])
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    filename = ""
    try:
        filename = _resolve_filename(payload)
        payload = {**payload, "filename": filename}
        if download_fn is None:
            from huggingface_hub import hf_hub_download
            download_fn = hf_hub_download

        downloaded = download_fn(
            **_download_kwargs(download_fn, payload)
        )
        final_file = _publish_download(str(downloaded), payload)
        try:
            size_bytes = os.path.getsize(final_file)
        except OSError:
            size_bytes = 0
        _write_json(result_path, {
            "status": "done",
            "file": final_file,
            "filename": filename,
            "received": size_bytes,
            "total": max(size_bytes, int(payload.get("total") or 0)),
        })
    except Exception as exc:  # le résultat permet au parent de distinguer l'échec
        _write_json(result_path, {
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}"[:500],
            "filename": filename,
        })


if __name__ == "__main__":  # pragma: no cover - utilisé uniquement en debug
    import sys

    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m services.model_download_worker PAYLOAD.json")
    with open(sys.argv[1], encoding="utf-8") as handle:
        run_download_worker(json.load(handle))
