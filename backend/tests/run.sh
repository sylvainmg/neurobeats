#!/bin/sh
# Lance le CLI terminal de REFERENCE (tests/cli_reference.py).
# Le venv et le moteur sont sous backend/ (dossier parent de tests/).
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/.." && pwd)"
exec "$BACKEND/.venv/bin/python" "$HERE/cli_reference.py" "$@"
