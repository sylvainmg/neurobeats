"""Tests unitaires du gestionnaire durable de modèles IA locaux.

Aucun test n'atteint le réseau : les workers sont remplacés par des processus
factices et le worker Hugging Face reçoit une fonction de téléchargement locale.
Le script conserve le style autonome des autres tests du backend et se termine
avec un code non nul si une vérification échoue.

Usage: backend/.venv/bin/python backend/tests/test_models.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

_TEMP_ROOT = tempfile.mkdtemp(prefix="neurobeats-model-jobs-")
_TEMP_DATA = tempfile.mkdtemp(prefix="neurobeats-model-data-")
# Doit preceder les imports : core.config fige DATA_ROOT a la lecture, et le
# profil (base du choix IA) ne doit jamais etre celui de developpement.
os.environ["NEUROBEATS_MODELS_DIR"] = _TEMP_ROOT
os.environ["NEUROBEATS_DATA_DIR"] = _TEMP_DATA
os.environ["NEUROBEATS_PROFILE"] = "modeltest"

from services import model_download_worker as worker  # noqa: E402
from services import models  # noqa: E402

CHECKS = []
_OLD_ENV = {
    name: os.environ.get(name)
    for name in ("NEUROBEATS_MODELS_DIR", "NEUROBEATS_CATALOG_PATH")
}
_OLD_CATALOG = models._CATALOG
_OLD_FACTORY = models._PROCESS_FACTORY


def check(name: str, condition: bool, detail: str = "") -> None:
    CHECKS.append(bool(condition))
    suffix = f"  [{detail}]" if detail else ""
    print(f"  {'OK   ' if condition else 'ECHEC'} {name}{suffix}")


class FakeProcess:
    """Processus synchrone minimal, sans thread ni fichier réel."""

    _next_pid = 91000

    def __init__(self) -> None:
        FakeProcess._next_pid += 1
        self.pid = FakeProcess._next_pid
        self.daemon = True
        self.running = False
        self.terminated = False
        self.killed = False

    def start(self) -> None:
        self.running = True

    def poll(self):
        return None if self.running else 0

    def terminate(self) -> None:
        self.terminated = True
        self.running = False

    def kill(self) -> None:
        self.killed = True
        self.running = False

    def join(self, timeout=None) -> None:
        del timeout


def reset_runtime() -> None:
    models._PROCESS_FACTORY = None
    models._PROCESSES.clear()
    models._PROGRESS_CACHE.clear()
    models._DOWNLOAD_JOBS.clear()
    models._STATE_PATH = None
    models._CATALOG_SOURCE = "test"


def setup_models() -> None:
    os.environ["NEUROBEATS_MODELS_DIR"] = _TEMP_ROOT
    reset_runtime()
    catalog_path = os.environ.get("NEUROBEATS_CATALOG_PATH") or os.path.join(
        os.path.dirname(models.__file__), "curated_models.json")
    models._CATALOG_SOURCE = catalog_path
    models._CATALOG = {
        "models": [
            {
                "id": "test-a", "name": "Test A", "repo": "fake/repo-a",
                "file": "test-a.gguf", "pattern": "test-a.gguf", "size_gb": 0.001,
            },
            {
                "id": "test-b", "name": "Test B", "repo": "fake/repo-b",
                "file": "test-b.gguf", "pattern": "test-b.gguf", "size_gb": 0.001,
            },
            {
                "id": "test-c", "name": "Test C", "repo": "fake/repo-c",
                "file": "test-c.gguf", "pattern": "test-c.gguf", "size_gb": 0.001,
            },
            {
                "id": "test-d", "name": "Test D", "repo": "fake/repo-d",
                "file": "test-d.gguf", "pattern": "test-d.gguf", "size_gb": 0.001,
            },
            {
                # Estimation volontairement gonflee : le worker publiera un
                # fichier de 5 octets, le test verifie que le job termine
                # n'affiche pas 99 % a cause de l'estimation du catalogue.
                "id": "test-e", "name": "Test E", "repo": "fake/repo-e",
                "file": "test-e.gguf", "pattern": "test-e.gguf", "size_gb": 0.01,
            },
            {
                # Sans taille : la garde d'espace doit refuser le transfert,
                # faute de pouvoir verifier qu'il tient sur le disque.
                "id": "test-unknown", "name": "Test inconnu", "repo": "fake/repo-u",
                "file": "test-u.gguf", "pattern": "test-u.gguf",
            },
        ]
    }


def cleanup() -> None:
    try:
        models.shutdown_downloads()
    except Exception:
        pass
    models._PROCESS_FACTORY = _OLD_FACTORY
    models._CATALOG = _OLD_CATALOG
    models._CATALOG_SOURCE = None
    for name, value in _OLD_ENV.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    shutil.rmtree(_TEMP_ROOT, ignore_errors=True)


def state(job_id: str) -> dict:
    return json.loads(models.download_snapshot(job_id))


def write_partial(job: dict, size: int, name: str = "blob.incomplete") -> Path:
    partial = Path(job["staging_path"]) / ".cache" / "huggingface" / "download" / name
    partial.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(b"x" * size)
    return partial


def cas_durable_controls() -> None:
    processes: list[FakeProcess] = []

    def factory(_payload):
        process = FakeProcess()
        processes.append(process)
        return process

    models._PROCESS_FACTORY = factory
    started = json.loads(models.start_download("test-a"))
    job_id = started["job_id"]
    initial = state(job_id)
    check("start : job public persiste", initial["model_id"] == "test-a"
          and initial["status"] in ("starting", "resolving", "downloading"),
          str(initial))
    check("metadata : staging dedie", Path(initial["staging_path"]).is_dir(),
          initial["staging_path"])

    partial = write_partial(initial, 11)
    check("progression : fragment du job lu", state(job_id)["received"] == 11)
    try:
        models.resume_download(job_id)
        resume_failed = False
    except models.DownloadConflict:
        resume_failed = True
    check("reprise concurrente refusee (409)", resume_failed)

    paused = json.loads(models.pause_download(job_id))
    check("pause : état persisté", paused["status"] == "paused")
    check("pause : worker termine et reap", processes[-1].terminated)
    check("pause : .incomplete preserve", partial.is_file() and partial.stat().st_size == 11)
    check("pause : idempotente", json.loads(models.pause_download(job_id))["status"] == "paused")

    resumed = json.loads(models.resume_download(job_id))
    check("reprise : même staging", resumed["staging_path"] == initial["staging_path"]
          and resumed["received"] == 11, str(resumed))
    resumed_partial = write_partial(resumed, 19, "blob-2.incomplete")
    check("reprise : progression repart du partial", state(job_id)["received"] == 30,
          str(state(job_id)))

    cancelled = json.loads(models.cancel_download(job_id))
    check("annulation : état terminal", cancelled["status"] == "cancelled")
    check("annulation : staging nettoye", not Path(cancelled["staging_path"]).exists())
    check("annulation : idempotente", json.loads(models.cancel_download(job_id))["status"] == "cancelled")
    try:
        models.resume_download(job_id)
        resume_cancelled = False
    except models.DownloadConflict:
        resume_cancelled = True
    check("annulation : reprise interdite (409)", resume_cancelled)
    check("partial avant annulation bien distinct", resumed_partial.name.endswith(".incomplete"))


def cas_isolation_and_reconcile() -> None:
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    first = json.loads(models.start_download("test-a"))["job_id"]
    second = json.loads(models.start_download("test-b"))["job_id"]
    first_state = state(first)
    second_state = state(second)
    write_partial(first_state, 3, "only-a.incomplete")
    write_partial(second_state, 7, "only-b.incomplete")
    check("progression : staging A isole", state(first)["received"] == 3)
    check("progression : staging B isole", state(second)["received"] == 7)

    # Simule un backend qui n'a plus les objets Process : le registre durable
    # doit mettre les jobs en erreur (processus disparu sans resultat), jamais
    # les supprimer ni renommer leur staging. Le retry reste possible.
    models._PROCESSES.clear()
    reconciled = {job["job_id"]: job for job in models.reconcile_download_jobs()}
    check("reconcile : job A en erreur", reconciled[first]["status"] == "error")
    check("reconcile : job B en erreur", reconciled[second]["status"] == "error")
    check("reconcile : metadata toujours sur disque", Path(models._jobs_path()).is_file())
    check("reconcile : fragments conserves", Path(first_state["staging_path"]).is_dir()
          and Path(second_state["staging_path"]).is_dir())
    cancelled = json.loads(models.cancel_download(first))
    check("annulation depuis error", cancelled["status"] == "cancelled"
          and not Path(first_state["staging_path"]).exists(), str(cancelled))


def cas_worker_api_and_manifest() -> None:
    staging = Path(_TEMP_ROOT) / "worker-case"
    models_dir = Path(_TEMP_ROOT) / "published"
    models_dir.mkdir(parents=True, exist_ok=True)
    result = staging / "worker-result.json"
    payload = {
        "job_id": "worker-case", "model_id": "test-a", "repo_id": "fake/repo-a",
        "filename": "worker.gguf", "pattern": "", "total": 5,
        "models_dir": str(models_dir), "staging_dir": str(staging),
        "result_path": str(result),
    }
    seen = {}

    def local_download(**kwargs):
        seen.update(kwargs)
        assert "tqdm_class" not in kwargs
        destination = Path(kwargs["local_dir"]) / kwargs["filename"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"model")
        return str(destination)

    worker.run_download_worker(payload, local_download)
    outcome = json.loads(result.read_text(encoding="utf-8"))
    check("worker : API HF sans tqdm_class", "tqdm_class" not in seen)
    check("worker : publication locale", outcome["status"] == "done"
          and (models_dir / "worker.gguf").is_file(), str(outcome))

    # Le manifeste est écrit de facon atomique et le modele devient visible.
    final_file = str(models_dir / "worker.gguf")
    models._record_manifest("test-a", final_file, {"name": "Test A"})
    manifest = json.loads(Path(models._manifest_path()).read_text(encoding="utf-8"))
    check("manifest : entee verrouillee/publiee", manifest["test-a"]["file"] == final_file,
          str(manifest))


def cas_real_worker_process() -> None:
    models._PROCESS_FACTORY = None
    previous_offline = os.environ.get("HF_HUB_OFFLINE")
    try:
        os.environ["HF_HUB_OFFLINE"] = "1"
        job_id = json.loads(models.start_download("test-d"))["job_id"]
        deadline = time.monotonic() + 10
        snapshot = state(job_id)
        while snapshot["status"] in ("starting", "resolving", "downloading"):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
            snapshot = state(job_id)
        models._stop_process(models._PROCESSES.get(job_id))
        check("worker reel : sortie durable", snapshot["status"] == "error"
              and bool(snapshot.get("error")), str(snapshot))
    finally:
        if previous_offline is None:
            os.environ.pop("HF_HUB_OFFLINE", None)
        else:
            os.environ["HF_HUB_OFFLINE"] = previous_offline


def cas_running_status_and_done_pct() -> None:
    """Le statut public suit les faits disque ; un job termine reste a 100 %."""
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    job_id = json.loads(models.start_download("test-e"))["job_id"]
    resolving = state(job_id)
    check("statut : resolution avant premier octet", resolving["status"] == "resolving",
          resolving["status"])
    write_partial(resolving, 7, "live.incomplete")
    downloading = state(job_id)
    check("statut : downloading des le premier fragment", downloading["status"] == "downloading",
          downloading["status"])

    # Le worker publie un fichier bien plus petit que l'estimation du catalogue.
    published = Path(_TEMP_ROOT) / "published" / "test-e.gguf"
    published.parent.mkdir(parents=True, exist_ok=True)
    published.write_bytes(b"gguf!")
    size = published.stat().st_size
    Path(models._job_result_path(job_id)).write_text(
        json.dumps({
            "status": "done", "file": str(published), "filename": "test-e.gguf",
            "received": size,
        }),
        encoding="utf-8",
    )
    processes[-1].running = False
    done = state(job_id)
    check("done : statut terminal", done["status"] == "done", str(done))
    check("done : total = taille reelle", done["received"] == done["total"] == size, str(done))
    check("done : progression a 100 %", done["pct"] == 100.0, str(done))
    check("done : 100 % stable au snapshot suivant", state(job_id)["pct"] == 100.0)
    check("done : staging supprime", not Path(done["staging_path"]).exists())


def cas_retry_reuses_staging() -> None:
    """« Reessayer » reprend le fragment : pas de second staging, pas de 409."""
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    staging_root = Path(models._downloads_dir()) / "staging"

    def staging_dirs() -> set[str]:
        return {entry.name for entry in staging_root.iterdir()} if staging_root.is_dir() else set()

    def fail_current_process(job_id: str, message: str) -> None:
        processes[-1].running = False
        Path(models._job_result_path(job_id)).write_text(
            json.dumps({"status": "error", "error": message}), encoding="utf-8")

    active = json.loads(models.start_download("test-a"))
    job_id = active["job_id"]
    first = state(job_id)
    before_dirs = staging_dirs()
    write_partial(first, 13, "retry.incomplete")
    models.pause_download(job_id)

    retried = json.loads(models.start_download("test-a"))
    check("retry pause : meme job et mode resume", retried["job_id"] == job_id
          and retried.get("resumed") is True, str(retried))
    resumed = state(job_id)
    check("retry pause : fragment conserve", resumed["received"] == 13
          and resumed["staging_path"] == first["staging_path"], str(resumed))
    check("retry pause : aucun staging ajoute", staging_dirs() == before_dirs,
          str(sorted(staging_dirs() - before_dirs)))

    fail_current_process(job_id, "reseau coupe")
    errored = state(job_id)
    check("retry : etat error persiste", errored["status"] == "error"
          and errored["error"] == "reseau coupe", str(errored))
    retried_error = json.loads(models.start_download("test-a"))
    check("retry error : meme job", retried_error["job_id"] == job_id, str(retried_error))
    relaunched = state(job_id)
    check("retry error : erreur effacee et actif", relaunched["error"] is None
          and relaunched["status"] in ("starting", "resolving", "downloading"), str(relaunched))

    fail_current_process(job_id, "reseau coupe encore")
    check("retry : second echec", state(job_id)["status"] == "error")
    cancelled = json.loads(models.cancel_download(job_id))
    check("annulation depuis error", cancelled["status"] == "cancelled"
          and cancelled["error"] is None, str(cancelled))
    check("annulation depuis error : staging nettoye", not Path(cancelled["staging_path"]).exists())


def cas_worker_env_isole() -> None:
    """Le cache xet du worker reste dans le models dir de l'instance."""
    os.environ["NEUROBEATS_INSTANCE_ID"] = "instance-worker-test"
    try:
        env = models._worker_env()
    finally:
        os.environ.pop("NEUROBEATS_INSTANCE_ID", None)
    xet_cache = Path(env.get("HF_XET_CACHE", ""))
    hf_home = Path(env.get("HF_HOME", ""))
    models_dir = Path(models.models_dir())
    check("worker : marqueur de worker", env.get("NEUROBEATS_DOWNLOAD_WORKER") == "1")
    check("worker : HF_XET_CACHE confine au models dir",
          xet_cache.is_relative_to(models_dir), f"{xet_cache} sous {models_dir}")
    check("worker : HF_HOME confine au models dir",
          hf_home.is_relative_to(models_dir), f"{hf_home} sous {models_dir}")
    check("worker : cache xet distinct du cache HF global",
          not xet_cache.is_relative_to(Path.home() / ".cache" / "huggingface"))
    check("worker : heritage de l'environnement du backend",
          env.get("NEUROBEATS_INSTANCE_ID") == "instance-worker-test")


def cas_job_id_malveillant() -> None:
    """Un job_id hors format ne touche jamais le disque (404, pas de traversee)."""
    attacks = ["../manifest", "..", "", "1/../2", "abc", "1;rm", "99999999999999"]
    rejected = 0
    for attack in attacks:
        for tool in (models.download_snapshot, models.pause_download,
                     models.resume_download, models.cancel_download):
            try:
                tool(attack)
                check(f"job_id {attack!r} rejete par {tool.__name__}", False, attack)
            except models.DownloadJobNotFound:
                rejected += 1
            except Exception as exc:
                check(f"job_id {attack!r} rejete par {tool.__name__}", False,
                      f"{type(exc).__name__}: {exc}")
    check("job_id malveillants : tous rejetes en 404",
          rejected == len(attacks) * 4, f"{rejected} rejets")
    poisoned = Path(_TEMP_ROOT) / "staging" / ".." / "poison.txt"
    check("job_id : aucun fichier hors staging", not poisoned.is_file())


def cas_delete_downloaded() -> None:
    """DELETE purge le .gguf + le manifeste, arrete le serveur actif."""
    published = Path(_TEMP_ROOT) / "test-b.gguf"
    published.write_bytes(b"gguf-bytes-12345")
    models._record_manifest("test-b", str(published), {"name": "Test B"})
    before = json.loads(models.list_downloaded())
    check("delete : modele visible avant", "test-b" in before["models"])
    outcome = json.loads(models.delete_downloaded("test-b"))
    check("delete : octets supprimes", outcome["deleted_bytes"] == len(b"gguf-bytes-12345"),
          str(outcome))
    after = json.loads(models.list_downloaded())
    check("delete : manifeste nettoye", "test-b" not in after["models"])
    check("delete : fichier purge", not published.exists())
    try:
        models.delete_downloaded("test-b")
        check("delete : second appel en 404", False)
    except ValueError as exc:
        check("delete : second appel en 404", "non telecharge" in str(exc), str(exc))
    try:
        models.delete_downloaded("pas-au-catalogue")
        check("delete : modele inconnu rejete", False)
    except ValueError as exc:
        check("delete : modele inconnu rejete", "inconnu du catalogue" in str(exc), str(exc))


def cas_vitesse_exposee() -> None:
    """Le constat public (REST + SSE) expose la vitesse de telechargement."""
    job = {"job_id": "9", "model_id": "test-a", "status": "downloading",
           "received": 1024, "total": 2048, "pct": 50.0, "speed_mbps": 3.75}
    public = models._public_job(job)
    check("vitesse : exposee dans le constat public",
          public["speed_mbps"] == 3.75, str(public))
    job["speed_mbps"] = None
    check("vitesse : 0 si absente", models._public_job(job)["speed_mbps"] == 0.0)
    job["speed_mbps"] = -5
    check("vitesse : jamais negative", models._public_job(job)["speed_mbps"] == 0.0)


def cas_statut_moteur_et_invariant() -> None:
    """Le moteur expose un etat lisible et ne sert que le modele selectionne."""
    previous_server, previous_proc = models._SERVER, models._SERVER_PROC
    real_ready = models._http_ready
    try:
        models._SERVER, models._SERVER_PROC = None, None
        models._PROCESS_FACTORY = _OLD_FACTORY
        check("statut : idle sans serveur",
              models.embedded_status().get("state") == "idle",
              str(models.embedded_status()))

        models._SERVER = {"pid": 1, "port": 1, "model_id": "m", "since": "t"}
        # Le port est ouvert mais l'API ne repond pas encore : c'est le cas
        # pendant le chargement du modele (llama-server bind avant de charger).
        models._http_ready = lambda _port: False
        loading = models.embedded_status()
        check("statut : loading avant disponibilite",
              loading.get("state") == "loading" and loading.get("model_id") == "m",
              str(loading))

        models._http_ready = lambda _port: True
        ready = models.embedded_status()
        check("statut : ready quand l'API repond",
              ready.get("state") == "ready" and ready.get("pid") == 1, str(ready))
    finally:
        models._SERVER, models._SERVER_PROC = previous_server, previous_proc
        models._http_ready = real_ready

    # Le choix par defaut de ce profil de test est externe : le moteur doit
    # refuser de charger un modele local qui n'est pas la selection.
    try:
        models.ensure_embedded("modele-hors-selection")
        check("invariant : modele hors selection refuse", False, "aucune erreur levee")
    except RuntimeError as exc:
        check("invariant : modele hors selection refuse",
              "sélectionné" in str(exc), str(exc)[:70])


def cas_modele_hors_catalogue() -> None:
    """Un modele Hugging Face suit le meme flux que le catalogue cure."""
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    previous_server = models._SERVER
    entry = models.custom_entry("bartowski/Repo-GGUF", "Model-Q4_K_M.gguf",
                                size_bytes=2_000_000_000)
    model_id = str(entry["id"])
    check("hf : identifiant repo/fichier",
          model_id == "bartowski/Repo-GGUF/Model-Q4_K_M.gguf", model_id)

    started = json.loads(models.start_download(entry=entry))
    job_id = started["job_id"]
    check("hf : job cree hors catalogue", started["model_id"] == model_id, str(started))

    # Le worker publie : on simule son resultat puis la fin du process.
    published = Path(_TEMP_ROOT) / "Model-Q4_K_M.gguf"
    published.write_bytes(b"gguf-hf-model")
    Path(models._job_result_path(job_id)).write_text(json.dumps({
        "status": "done", "file": str(published), "filename": published.name,
        "received": published.stat().st_size,
    }), encoding="utf-8")
    processes[-1].running = False
    done = state(job_id)
    check("hf : telechargement publie", done["status"] == "done", str(done))

    manifest = json.loads(Path(models._manifest_path()).read_text(encoding="utf-8"))
    record = manifest.get(model_id) or {}
    check("hf : manifeste enrichi (repo + ctx)",
          record.get("repo") == "bartowski/Repo-GGUF" and record.get("ctx") == 8192,
          str(record))
    relue = models._entry(model_id)
    check("hf : entree relue du manifeste (hors catalogue)",
          relue.get("file") == str(published) and relue.get("repo") == "bartowski/Repo-GGUF",
          str(relue))

    try:
        models._entry("inconnu/totalement/Absent.gguf")
        check("hf : entree inconnue toujours refusee", False)
    except ValueError:
        check("hf : entree inconnue toujours refusee", True)

    models._SERVER = None
    try:
        outcome = json.loads(models.delete_downloaded(model_id))
        check("hf : suppression possible",
              outcome["deleted_bytes"] > 0 and not published.exists(), str(outcome))
    finally:
        models._SERVER = previous_server


def cas_espace_et_ctx() -> None:
    """L'espace compte staging+final ; le ctx vient du catalogue."""
    models._CATALOG["models"].append({
        "id": "test-ctx", "name": "Test CTX", "repo": "fake/repo-ctx",
        "file": "test-ctx.gguf", "pattern": "test-ctx.gguf", "size_gb": 0,
        "ctx": 16384,
    })
    cmd = models._embedded_cmd("/tmp/fake-llama-server", "test-ctx", "/tmp/fake.gguf", 51234)
    check("ctx : catalogue propage a llama-server", "-c" in cmd
          and cmd[cmd.index("-c") + 1] == "16384", str(cmd))
    check("gpu : aucun -ngl force par defaut (auto-fit de llama.cpp)",
          "--n-gpu-layers" not in cmd, str(cmd))
    default_cmd = models._embedded_cmd("/tmp/fake-llama-server", "test-a", "/tmp/fake.gguf", 51234)
    check("ctx : defaut 8192 sans champ", default_cmd[default_cmd.index("-c") + 1] == "8192")
    os.environ["NEUROBEATS_GPU_LAYERS"] = "12"
    try:
        forced = models._embedded_cmd("/tmp/fake-llama-server", "test-a", "/tmp/fake.gguf", 51234)
        check("gpu : valeur explicite transmise",
              forced[forced.index("--n-gpu-layers") + 1] == "12", str(forced))
    finally:
        os.environ.pop("NEUROBEATS_GPU_LAYERS", None)
    free = shutil.disk_usage(_TEMP_ROOT).free
    free_gb = free / (1024 ** 3)
    # Le bug corrige : un modele qui tient dans l'espace libre (moitie ici) etait
    # refuse parce que le controle exigeait deux fois sa taille.
    try:
        models._ensure_space({"size_gb": free_gb * 0.5})
        check("espace : modele qui tient accepte", True, f"{free_gb * 0.5:.1f} Go libres {free_gb:.1f}")
    except ValueError as exc:
        check("espace : modele qui tient accepte", False, str(exc)[:80])
    try:
        models._ensure_space({"size_gb": free_gb * 2 + 50})
        check("espace : volume enorme refuse", False)
    except ValueError as exc:
        check("espace : volume enorme refuse", "insuffisant" in str(exc), str(exc)[:80])


def cas_progression_temps_reel() -> None:
    """La progression vient du rapport du worker, pas seulement du staging."""
    # 1) Le worker publie sa progression (tqdm -> progress.json).
    staging = Path(_TEMP_ROOT) / "progress-case"
    staging.mkdir(parents=True, exist_ok=True)
    reporter = worker._progress_reporter(str(staging))
    bar = reporter(total=9_000_000, unit="B")
    bar.update(2_500_000)
    bar.update(1_200_000)
    bar.close()  # fin de transfert : la valeur finale doit etre publiee
    published = json.loads((staging / "progress.json").read_text(encoding="utf-8"))
    check("progression : rapport ecrit par le worker",
          published["received"] == 3_700_000 and published["total"] == 9_000_000,
          str(published))

    # 2) `tqdm_class` n'est transmis que si la version l'accepte.
    def with_tqdm(repo_id, filename, local_dir, tqdm_class=None, force_download=False):
        return ""

    def old_api(repo_id, filename, local_dir):
        return ""

    payload = {"repo_id": "r", "filename": "f.gguf", "staging_dir": str(staging)}
    check("progression : tqdm_class transmis quand supporte",
          "tqdm_class" in worker._download_kwargs(with_tqdm, payload),
          str(sorted(worker._download_kwargs(with_tqdm, payload))))
    check("progression : version ancienne reste compatible",
          "tqdm_class" not in worker._download_kwargs(old_api, payload),
          str(sorted(worker._download_kwargs(old_api, payload))))

    # 3) Le service prefere le rapport au staging, et adopte le total reel.
    models._PROCESS_FACTORY = lambda _payload: FakeProcess()
    job_id = json.loads(models.start_download("test-a"))["job_id"]
    first = state(job_id)
    job_staging = Path(first["staging_path"])
    job_staging.mkdir(parents=True, exist_ok=True)
    (job_staging / "progress.json").write_text(json.dumps(
        {"received": 5_000_000, "total": 9_000_000}), encoding="utf-8")
    live = state(job_id)
    check("progression : rapport prioritaire sur la taille du staging",
          live["received"] == 5_000_000, str(live))
    check("progression : total reel adopte", live["total"] == 9_000_000, str(live))
    check("progression : pourcentage coherent", live["pct"] == 55.56, str(live["pct"]))
    models.cancel_download(job_id)


def cas_garde_espace() -> None:
    """Aucun telechargement ne peut remplir le disque."""
    free_gb = models._free_bytes() / (1024 ** 3)

    try:
        models._ensure_space({"size_gb": free_gb + 1})
        check("garde : modele plus gros que le disque refuse", False)
    except ValueError as exc:
        check("garde : modele plus gros que le disque refuse",
              "insuffisant" in str(exc) and "Go" in str(exc), str(exc)[:90])

    try:
        models._ensure_space({"size_gb": free_gb + 1},
                             already_bytes=int((free_gb + 0.5) * 1024 ** 3))
        check("garde : reprise dont le reste tient acceptee", True)
    except ValueError as exc:
        check("garde : reprise dont le reste tient acceptee", False, str(exc)[:80])

    try:
        models._ensure_space({"size_gb": 0})
        check("garde : taille inconnue refusee", False)
    except ValueError as exc:
        check("garde : taille inconnue refusee", "inconnue" in str(exc), str(exc)[:70])

    # Le refus vaut des le depart : aucun job n'est cree.
    models._PROCESS_FACTORY = lambda _payload: FakeProcess()
    try:
        models.start_download("test-unknown")
        check("garde : aucun job cree sans taille", False)
    except ValueError:
        check("garde : aucun job cree sans taille",
              "test-unknown" not in models._load_jobs_locked(), "")

    # Disque plein PENDANT le transfert : arret propre, fragment conserve.
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    job_id = json.loads(models.start_download("test-a"))["job_id"]
    partial = write_partial(state(job_id), 5)
    real_free = models._free_bytes
    models._free_bytes = lambda: 10 * 1024 ** 2  # 10 Mo < marge de securite
    try:
        stopped = state(job_id)
    finally:
        models._free_bytes = real_free
    check("garde : transfert arrete quand le disque se remplit",
          stopped["status"] == "error" and "disque" in (stopped["error"] or "").lower(),
          str(stopped))
    check("garde : worker termine", processes[-1].terminated)
    check("garde : fragment conserve malgre l'arret", partial.is_file())
    models.cancel_download(job_id)


def cas_choix_apres_suppression() -> None:
    """Supprimer le modele choisi ne laisse jamais un choix fantome."""
    from services import llm
    from services.db_access import profile_read, profile_write

    saved_ai = profile_read().get("ai")
    manifest_path = Path(models._manifest_path())
    saved_manifest = manifest_path.read_text(encoding="utf-8") if manifest_path.is_file() else None
    calls: list = []
    real_set = llm.set_selection
    previous_server = models._SERVER
    models._SERVER = None

    def fake_set(kind=None, model=None, **blocks):
        calls.append((kind, model))
        return json.dumps({"status": "ok"})

    def reset_manifest() -> None:
        """Manifeste vide : ce cas ne depend pas des autres."""
        manifest_path.write_text("{}", encoding="utf-8")

    def publish(model_id: str, name: str) -> Path:
        path = Path(_TEMP_ROOT) / f"{model_id}.gguf"
        path.write_bytes(b"gguf-choix")
        models._record_manifest(model_id, str(path), {"name": name, "repo": "r", "ctx": 8192})
        return path

    def select(model_id: str) -> None:
        profile = profile_read()
        profile["ai"] = {"selection": {"kind": "embedded", "model": model_id}}
        profile_write(profile)

    try:
        llm.set_selection = fake_set

        # 1) Dernier modele local : on revient au fournisseur par defaut.
        reset_manifest()
        publish("choix-seul", "Seul")
        select("choix-seul")
        models.delete_downloaded("choix-seul")
        check("suppression : plus de modele local -> fournisseur par defaut",
              calls == [(llm.DEFAULT_KIND, None)], str(calls))

        # 2) Un autre modele reste : le choix bascule dessus.
        calls.clear()
        reset_manifest()
        publish("choix-a", "A")
        publish("choix-b", "B")
        select("choix-a")
        models.delete_downloaded("choix-a")
        check("suppression : choix bascule sur un modele restant",
              calls == [("embedded", "choix-b")], str(calls))

        # 3) Supprimer un modele NON choisi ne touche pas au choix.
        calls.clear()
        reset_manifest()
        publish("choix-c", "C")
        publish("choix-d", "D")
        select("choix-d")
        models.delete_downloaded("choix-c")
        check("suppression : choix d'un autre modele inchange", calls == [], str(calls))
    finally:
        llm.set_selection = real_set
        manifest_path.write_text(saved_manifest or "{}", encoding="utf-8")
        profile = profile_read()
        if saved_ai is None:
            profile.pop("ai", None)
        else:
            profile["ai"] = saved_ai
        profile_write(profile)
        models._SERVER = previous_server


def cas_shutdown_preserves_partial() -> None:
    processes: list[FakeProcess] = []
    models._PROCESS_FACTORY = lambda _payload: (lambda p: (processes.append(p), p)[1])(FakeProcess())
    job_id = json.loads(models.start_download("test-c"))["job_id"]
    current = state(job_id)
    partial = write_partial(current, 23, "shutdown.incomplete")
    models.shutdown_downloads()
    after = state(job_id)
    check("shutdown : worker reap", processes[-1].terminated)
    check("shutdown : job paused", after["status"] == "paused")
    check("shutdown : partial conserve", partial.is_file() and partial.stat().st_size == 23)


def cas_health_identity() -> None:
    from main import _health_identity_fields

    names = ("NEUROBEATS_INSTANCE_ID", "NEUROBEATS_PROFILE", "NEUROBEATS_PORT")
    previous = {name: os.environ.get(name) for name in names}
    try:
        os.environ["NEUROBEATS_INSTANCE_ID"] = "instance-test-42"
        os.environ["NEUROBEATS_PROFILE"] = "desktop-test"
        os.environ["NEUROBEATS_PORT"] = "4321"
        fields = _health_identity_fields()
        check("health : identite exacte", fields["instance_id"] == "instance-test-42")
        check("health : service et profil", fields["service"] == "neurobeats-backend"
              and fields["profile"] == "desktop-test", str(fields))
        check("health : port runtime", fields["port"] == 4321
              and fields["runtime_port"] == 4321, str(fields))
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def cas_route_contract() -> None:
    from routers.profile import router

    methods = {
        (route.path, method)
        for route in router.routes
        for method in (route.methods or set())
    }
    expected = {
        ("/api/profile/ai/models/downloads", "GET"),
        ("/api/profile/ai/models/downloads/{job_id}", "GET"),
        ("/api/profile/ai/models/downloads/{job_id}/pause", "POST"),
        ("/api/profile/ai/models/downloads/{job_id}/resume", "POST"),
        ("/api/profile/ai/models/downloads/{job_id}", "DELETE"),
        ("/api/profile/ai/models/download", "POST"),
        ("/api/profile/ai/models/download/{job_id}", "GET"),
        # `:path` : l'identifiant d'un modele Hugging Face contient des « / ».
        ("/api/profile/ai/models/{model_id:path}", "DELETE"),
    }
    check("routes : contrat downloads complet", expected <= methods,
          str(sorted(expected - methods)))

    # `{model_id:path}` est glouton : s'il etait declare avant, il capterait
    # `/ai/models/downloads/{job_id}` et l'annulation d'un job casserait.
    order = [
        (route.path, sorted(route.methods or set()))
        for route in router.routes
    ]
    job_delete = next(index for index, (path, methods) in enumerate(order)
                      if path == "/api/profile/ai/models/downloads/{job_id}"
                      and "DELETE" in methods)
    model_delete = next(index for index, (path, methods) in enumerate(order)
                        if path == "/api/profile/ai/models/{model_id:path}")
    check("routes : suppression de job declaree avant le chemin glouton",
          job_delete < model_delete, f"job={job_delete} modele={model_delete}")


def main() -> int:
    try:
        setup_models()
        print("cas 1 : pause/reprise/annulation et persistance")
        cas_durable_controls()
        print("cas 2 : isolation du staging et reconciliation")
        cas_isolation_and_reconcile()
        print("cas 3 : worker HF local et manifeste")
        cas_worker_api_and_manifest()
        print("cas 4 : worker reel et shutdown preservant les fragments")
        cas_real_worker_process()
        cas_shutdown_preserves_partial()
        print("cas 5 : identite de l'instance health")
        cas_health_identity()
        print("cas 6 : contrat des routes de telechargement")
        cas_route_contract()
        print("cas 7 : statut public et progression d'un job termine")
        cas_running_status_and_done_pct()
        print("cas 8 : retry d'un job en pause ou en erreur")
        cas_retry_reuses_staging()
        print("cas 9 : environnement isole du worker")
        cas_worker_env_isole()
        print("cas 10 : job_id malveillants, DELETE modele, espace et ctx")
        cas_job_id_malveillant()
        cas_delete_downloaded()
        cas_espace_et_ctx()
        print("cas 11 : vitesse de telechargement exposee")
        cas_vitesse_exposee()
        print("cas 12 : statut du moteur et invariant de selection")
        cas_statut_moteur_et_invariant()
        print("cas 13 : modele hors catalogue (Hugging Face)")
        cas_modele_hors_catalogue()
        print("cas 14 : garde d'espace disque")
        cas_garde_espace()
        print("cas 15 : progression en temps reel")
        cas_progression_temps_reel()
        print("cas 16 : choix apres suppression d'un modele")
        cas_choix_apres_suppression()
    finally:
        cleanup()
    ok_count = sum(CHECKS)
    print(f"\n{ok_count}/{len(CHECKS)} verifications OK")
    return 0 if ok_count == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
