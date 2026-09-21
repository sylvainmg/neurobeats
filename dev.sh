#!/usr/bin/env bash
#
# NeuroBeats — pilotage des deux serveurs de developpement.
#
#   ./dev.sh              arrete puis relance backend + frontend, attend qu'ils
#                         repondent, et affiche l'etat
#   ./dev.sh stop         arrete les deux
#   ./dev.sh status       affiche l'etat sans rien relancer
#   ./dev.sh --force      passe outre le garde-fou « une lecture est en cours »
#
# Le script ne touche JAMAIS a la lecture (ni stop, ni pause) : s'il detecte une
# lecture en cours, il refuse d'agir, parce que relancer le backend tue le daemon
# mpv — donc le son. Ce refus est volontaire : c'est exactement l'erreur qui a
# coupe la musique plusieurs fois.
#
# Les serveurs sont identifies PAR PORT : le script fonctionne donc aussi pour
# des serveurs lances a la main, hors de lui.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
# Le port est la source de verite pour identifier un serveur : pas de fichier de
# pid a maintenir (il deviendrait faux au moindre redemarrage manuel).
BACKEND_LOG="/tmp/neurobeats-backend.log"
FRONTEND_LOG="/tmp/neurobeats-frontend.log"

# Le backend doit ecouter sur le port attendu par le front (web/.env.local) :
# on le lit la plutot que de risquer une divergence silencieuse.
_default_backend_port() {
  local from_env=""
  if [ -f "$ROOT/web/.env.local" ]; then
    from_env="$(sed -n 's/.*:\/\/[^:/]*:\([0-9]\{2,\}\)$/\1/p' "$ROOT/web/.env.local" | head -1)"
  fi
  printf '%s' "${NEUROBEATS_PORT:-${from_env:-8040}}"
}
BACKEND_PORT="$(_default_backend_port)"

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
err()  { printf '  %s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
}

# ------------------------------------------------------------------- utilitaires

# PIDs a l'ecoute sur un port (le `:` evite de confondre 3000 et 13000).
pids_on_port() {
  ss -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p {print $0}' \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

wait_http() {
  local url="$1" timeout="${2:-90}" deadline=$((SECONDS + ${2:-90}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

# True (et affiche titre + temps restant) si un titre joue vraiment : charge,
# non en pause, position qui avance. C'est ce qui decide du garde-fou.
playing_info() {
  curl -fsS -m 3 "http://127.0.0.1:$BACKEND_PORT/api/now" 2>/dev/null \
    | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)["data"]
except Exception:
    sys.exit(1)
if not (d.get("playing") and not d.get("paused")):
    sys.exit(1)
def mmss(v):
    return "%d:%02d" % (int(v) // 60, int(v) % 60) if isinstance(v, (int, float)) else "?"
pos, dur = d.get("position"), d.get("duration")
reste = ""
if isinstance(pos, (int, float)) and isinstance(dur, (int, float)) and dur > pos:
    reste = "  (reste ~%s)" % mmss(dur - pos)
print("« %s »  %s / %s%s" % (d.get("title") or "?", mmss(pos), mmss(dur), reste))
' 2>/dev/null
}

# ----------------------------------------------------------------------- arret

# Arrete le serveur d'un port, en verifiant que le process est bien le notre
# (garde-fou : on ne tue pas un service tiers qui occuperait le port).
stop_one() {
  local label="$1" port="$2" pattern="$3"
  local pids pid cmd
  pids="$(pids_on_port "$port")"
  if [ -z "$pids" ]; then
    say "  $label : rien sur le port $port"
  else
    for pid in $pids; do
      cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      if [[ "$cmd" == *"$pattern"* ]]; then
        kill "$pid" 2>/dev/null || true
      else
        warn "$label : pid $pid sur :$port ne correspond pas a '$pattern', ignore"
      fi
    done
    local _i
    for _i in $(seq 1 20); do
      [ -z "$(pids_on_port "$port")" ] && break
      sleep 0.5
    done
    pids="$(pids_on_port "$port")"
    if [ -n "$pids" ]; then
      warn "$label : arret force"
      for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
      sleep 0.5
    fi
    ok "$label arrete"
  fi
}

stop_all() {
  say ""
  say "Arret des serveurs"
  stop_one "backend " "$BACKEND_PORT" "backend/main.py"
  stop_one "frontend" "$FRONTEND_PORT" "next"
}

# ------------------------------------------------------------------- demarrage

start_all() {
  say ""
  say "Demarrage des serveurs"
  ( cd "$ROOT" && launch "$BACKEND_LOG" env NEUROBEATS_PORT="$BACKEND_PORT" \
      NEUROBEATS_TIMING=1 backend/.venv/bin/python backend/main.py )
  ok "backend lance  -> $BACKEND_LOG"
  ( cd "$ROOT/web" && launch "$FRONTEND_LOG" npm run dev )
  ok "frontend lance -> $FRONTEND_LOG"
}

# Demarre un serveur DETACHE du script : nouvelle session (`setsid`) et stdin sur
# /dev/null. Sans cela, deux problemes : un `./dev.sh | ...` n'en finit jamais
# (le serveur garde le tube ouvert) et un kill du lanceur emporte les serveurs.
launch() {
  local log="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$log" 2>&1 </dev/null &
  else
    nohup "$@" >"$log" 2>&1 </dev/null &
  fi
}

wait_all() {
  say ""
  say "Attente de la disponibilite…"
  WAIT_FAILED=0
  if wait_http "http://127.0.0.1:$BACKEND_PORT/api/health" 90; then
    ok "backend pret sur :$BACKEND_PORT"
  else
    err "backend injoignable apres 90 s — voir $BACKEND_LOG"
    WAIT_FAILED=1
  fi
  if wait_http "http://127.0.0.1:$FRONTEND_PORT/" 120; then
    ok "frontend pret sur :$FRONTEND_PORT"
  else
    err "frontend injoignable apres 120 s — voir $FRONTEND_LOG"
    WAIT_FAILED=1
  fi
}

# ---------------------------------------------------------------------- etat

status() {
  local bp fp
  bp="$(pids_on_port "$BACKEND_PORT")"
  fp="$(pids_on_port "$FRONTEND_PORT")"
  say ""
  say "NeuroBeats — etat"
  say "  backend  :${BACKEND_PORT}   ${bp:-inactif}"
  say "  frontend :${FRONTEND_PORT}   ${fp:-inactif}"
  if [ -n "$bp" ]; then
    curl -fsS -m 5 "http://127.0.0.1:$BACKEND_PORT/api/health" 2>/dev/null \
      | python3 -c '
import json, sys
d = json.load(sys.stdin)["data"]
c = d.get("audio_cache", {})
print("  sante    streaming=%s  ws_clients=%s  cache_ram=%s titre(s) / %s Ko"
      % (d["streaming"], d["ws_clients"], c.get("tracks", 0), c.get("bytes", 0) // 1024))
' 2>/dev/null || warn "sante illisible"
    curl -fsS -m 5 "http://127.0.0.1:$BACKEND_PORT/api/now" 2>/dev/null \
      | python3 -c '
import json, sys
d = json.load(sys.stdin)["data"]
if d.get("playing") and not d.get("paused"):
    etat = "en lecture"
elif d.get("playing"):
    etat = "en pause"
else:
    etat = "arret"
print("  lecture  %s — %s" % (etat, d.get("title") or "(rien de charge)"))
' 2>/dev/null || warn "etat de lecture illisible"
  fi
}

# ----------------------------------------------------------------------- main

ACTION="restart"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    stop) ACTION="stop" ;;
    status) ACTION="status" ;;
    --force|-f) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Argument inconnu : $arg"; say ""; usage; exit 2 ;;
  esac
done

if [ "$ACTION" = "status" ]; then
  status
  exit 0
fi

# Garde-fou : ne jamais couper une lecture en cours.
if [ "$FORCE" -eq 0 ]; then
  if info="$(playing_info)"; then
    say ""
    say "  Lecture en cours : $info"
    err "Relancer tuerait le daemon mpv, donc le son."
    say "  Attends la fin du titre, ou assume-le explicitement : $0 --force"
    exit 1
  fi
fi

stop_all
if [ "$ACTION" = "stop" ]; then
  status
  exit 0
fi

start_all
wait_all
status
say ""
if [ "${WAIT_FAILED:-0}" -ne 0 ]; then
  err "Au moins un serveur n'a pas repondu."
  exit 1
fi
ok "Les deux serveurs sont prets."
