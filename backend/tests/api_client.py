"""NeuroBeats - client HTTP minimal du backend FastAPI.

Consomme uniquement les endpoints via HTTP : aucune logique metier, aucun import
du moteur. L'historique est detenu ici (client) et envoye a /api/chat ; le serveur
le tronque.

Usage:
    # 1) lancer le serveur
    backend/.venv/bin/python backend/main.py
    # 2) dans un autre terminal
    backend/.venv/bin/python backend/tests/api_client.py
    # autre URL :
    NEUROBEATS_API=http://127.0.0.1:8010 backend/.venv/bin/python backend/tests/api_client.py
"""
import json
import os
import urllib.error
import urllib.request

API = os.environ.get("NEUROBEATS_API", "http://127.0.0.1:8000")
MAX_MESSAGES = 20


def request(method, path, params=None, body=None, timeout=180):
    """Appel HTTP brut ; retourne le JSON {status, data, error}."""
    url = API + path
    if params:
        from urllib.parse import urlencode
        url += "?" + urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"status": "error", "error": f"HTTP {e.code}", "data": None}
    except urllib.error.URLError as e:
        return {"status": "error", "error": f"Serveur injoignable ({e.reason})", "data": None}


def main():
    """Boucle interactive : saisie utilisateur -> POST /api/chat -> reponse."""
    print(f"🎵 NeuroBeats API client -> {API}  (tape 'quit')")
    health = request("GET", "/api/health")
    if health.get("status") != "ok":
        print(f"Serveur indisponible : {health.get('error')}")
        print("Lance-le d'abord : backend/.venv/bin/python backend/main.py")
        return 1
    print(f"   santé : {json.dumps(health.get('data'), ensure_ascii=False)}\n")

    messages = []
    while True:
        try:
            user = input("Vous > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nA bientot !")
            break
        if user.lower() in ("quit", "exit"):
            print("A bientot !")
            break
        if not user:
            continue

        messages.append({"role": "user", "content": user})
        resp = request("POST", "/api/chat",
                       body={"messages": messages, "max_messages": MAX_MESSAGES})
        if resp.get("status") != "ok":
            print(f"\nNeuroBeats > ERREUR: {resp.get('error')}\n")
            messages.pop()
            continue

        data = resp.get("data") or {}
        for c in (data.get("tool_calls") or []):
            print(f"  [tool] {c.get('name')}{c.get('arguments')}")
        print(f"\nNeuroBeats > {data.get('reply', '')}\n")

        messages = data.get("messages") or messages + [
            {"role": "assistant", "content": data.get("reply", "")}]
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
