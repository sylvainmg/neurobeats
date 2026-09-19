"""Sonde reseau : mesure le debit descendant et ajuste la classe de qualite."""
import time

from core import config
from core.config import PROBE_BYTES, PROBE_URL, YDL_AUDIO_FORMATS
from services import state


def _apply_net_quality(q: str):
    """Applique la classe reseau : format yt-dlp dynamique."""
    state.NET_QUALITY = q if q in YDL_AUDIO_FORMATS else "high"
    config.YDL_AUDIO_OPTS["format"] = YDL_AUDIO_FORMATS[state.NET_QUALITY]


def net_probe(timeout: float = 30.0) -> str:
    """Mesure le debit descendant (1 thread fond au demarrage). Retourne high|mid|low."""
    import urllib.request
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(PROBE_URL, timeout=10) as r:
            got = len(r.read(PROBE_BYTES))
        dt = max(time.perf_counter() - t0, 0.01)
        mbps = got * 8 / dt / 1e6
        q = "high" if mbps >= 5 else ("mid" if mbps >= 1.5 else "low")
        _apply_net_quality(q)
        print(f"  [quality] réseau ~{mbps:.1f} Mbps -> classe {q} (format: {YDL_AUDIO_FORMATS[q]})",
              flush=True)
        return q
    except Exception as exc:
        _apply_net_quality("high")  # echec sonde : qualite max par defaut
        print(f"  [quality] sonde echec ({exc}), classe high par defaut", flush=True)
        return "high"
