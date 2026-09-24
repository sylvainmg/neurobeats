# NeuroBeats — Normes pour Agents Développeurs

## Commits : Convention Industrielle + Validation

### Format Message de Commit

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type** (requis) :

- `feat`: Nouvelle feature validée + testée
- `fix`: Bug corrigé + testé
- `refactor`: Restructuration sans changement comportement
- `perf`: Optimisation mesurée
- `test`: Tests ajoutés/améliorés
- `docs`: Documentation
- `chore`: Config, dépendances, tooling

**Scope** (recommandé) :

- `backend` / `frontend` / `moteur` / `db` / `api` / `recommendation` / `streaming`

**Subject** (requis) :

- Présent indicatif ("ajoute" pas "ajouté")
- Français ou anglais, cohérent dans la session
- <50 caractères max
- Pas de point final

**Body** (recommandé si >1 ligne) :

- Explique le POURQUOI, pas le QUOI
- Détaille l'impact, limites, validations
- Wrappé à ~72 caractères

**Footer** (optionnel) :

- `Fixes #123` (issue tracker)
- `BREAKING CHANGE: ...` si régression

### Exemples NeuroBeats

**✅ BON :**

```
feat(moteur): ajoute filtrage mood dur au streaming

- Paramètre force_genre=True sur start_streaming(mood)
- Filtre RAG + Markov intra-genre
- Bonus ×2.0 si exact match
- Validé: flux rap fr → 100% rap fr (GAZO/Lomepal/MMZ)
```

```
fix(api): corrige timeout reco 120s sur endpoint POST /api/recommend

Raison: inférence genre batch + recommandation O2 prennent ~80-120s.
Impact: évite erreur 408 sur réseau faible.
Testé: 10 recos consécutives, aucun timeout.
```

```
perf(moteur): cache embeddings RAM → 11.8s → 0.0s hit

- SentenceTransformer: embeddings stockés en SQLite
- Lookup avant encode() → hit 99% après 1er run
- Chiffre: 4 recos = 17.8s (froid) → 4.2s (chaud)
```

**❌ MAUVAIS :**

```
update stuff
fixed things
added feature
modifications
```

### Politique de Commit

**Règle d'or : 1 commit = 1 feature COMPLÈTE (validée + testée)**

**Règle absolue : ne JAMAIS commiter sans demande explicite.**

Un agent ne commit, n'amende ni ne pousse de sa propre initiative. Il prépare
et propose les changements ; le commit est une décision du développeur. Sans
instruction claire (« commit », « commite », « commit ça »), le travail reste
en working tree / non commité.

**Before commit (une fois la demande reçue) :**

1. ✅ Feature implémentée
2. ✅ Tests lancés + pas de régression
3. ✅ Logs ajoutés (si pertinent)
4. ✅ Documentation si nécessaire
5. ✅ Code reviewable (pas 500 lignes mélangées)

**Process (sur demande uniquement) :**

```bash
git add <files>
git commit -m "<type>(<scope>): <subject>

<body>"
git push
```

**Exemple session valide :**

```
feat(moteur): implémente auto-tagging genre via Ollama
fix(api): corrige parse réponse genre
perf(moteur): cache genres en SQLite
feat(backend): ajoute endpoint GET /api/genre-stats
test(moteur): valide inférence offline mode
```

**Exemple session INVALIDE :**

```
update
fix stuff
changes
wip
```

(❌ Commits vagues, pas testés)

### Checklist Pre-Commit

```
[ ] Feature complète et fonctionnelle
[ ] Tests validés (pas de régression)
[ ] Logs [type] ajoutés si pertinent
[ ] Code lisible, pas de dead code
[ ] Message suit convention (type + scope + subject)
[ ] Body explique POURQUOI pas juste QUOI
[ ] Pas de secrets/tokens/chemins hardcodés
```

### Branches (si applicable)

- `main` : version stable, testée
- `dev` : working branch pour features
- `feature/<nom>` : feature branches isolées

### Conseil

**Commit souvent, commit bien.** Un commit = une vraie décision de dev, pas une demi-ligne changeante. Ça rend l'historique explorable et les bugs faciles à reverter.

---

**Version :** 1.0 NeuroBeats
**Dernière MàJ :** Phase Backend (FastAPI)

---

## Commentaires & Documentation : Normes Professionnelles

### Principes

**Code qui parle pour lui-même** > commentaires verbeux
**Documentation pour le POURQUOI** > explication du QUOI
**Structure claire** > commentaires defensifs

### À ÉVITER : Clichés d'IA

**❌ Mauvais :**

```python
# Vérifier si l'utilisateur existe
if user:
    # Incrémenter le compteur
    user.count += 1
    # Sauvegarder
    db.save(user)
```

**❌ Pire :**

```python
# Initialiser la base de données
# Connecter au serveur
# Charger les données
# Afficher le résultat
```

**❌ Commentaire defensif :**

```python
# TODO: ce truc peut bugger
# FIXME: j'ai pas eu le temps
# HACK: ça marche mais c'est pas propre
```

### ✅ RECOMMANDÉ : Style Professionnel

**Règle 1 : Noms de variables/fonctions explicites → pas besoin de commenter le QUOI**

```python
# ❌ Mauvais
x = get_data()
if x > 5:
    do_thing(x)

# ✅ Bon
recommendation_score = calculate_recommendation_score(user_history)
if recommendation_score > CONFIDENCE_THRESHOLD:
    return recommendation
```

**Règle 2 : Commenter le POURQUOI et les décisions non-évidentes**

```python
# ❌ Mauvais
genre_cache = {}  # On cache les genres

# ✅ Bon
# Cache genres en mémoire (TTL session) car inférence Ollama coûte 14s.
# À l'opposé, embeddings vont en SQLite (réutilisation long-terme).
genre_cache = {}
```

**Règle 3 : Docstrings pour les fonctions publiques (format numpy/google)**

```python
# ❌ Mauvais (pas de docstring)
def get_recommendation(query, force_genre_filter=False):
    # ...code...

# ✅ Bon (docstring clair)
def get_recommendation(query: str, force_genre_filter: bool = False) -> list[dict]:
    """Retourne N recommandations basées query + historique utilisateur.

    Utilise RAG (Sentence-Transformers) + Markov O2 + stats utilisateur.
    Cache embeddings en RAM/SQLite pour perf (hit ~0.0s après 1er appel).

    Args:
        query: Genre cible ou requête libre (ex. "rap fr", "lofi chill")
        force_genre_filter: Si True, filtre strict par genre (100% genre cible)

    Returns:
        Liste de dicts {video_id, title, channel, genre, score}

    Raises:
        ConnectionError: Si Ollama down + pas de cache local

    Exemples:
        >>> get_recommendation("rap fr", force_genre_filter=True)
        [{'video_id': '...', 'title': 'GAZO - CARTIER', ...}]
    """
    # ...code...
```

**Règle 4 : Commenter les algo complexes, pas les boucles basiques**

```python
# ❌ Mauvais
for song in songs:  # Boucle sur les chansons
    score = calculate(song)  # Calculer le score

# ✅ Bon (pas besoin, c'est clair)
for song in songs:
    score = calculate(song)

# ✅ Bon (pour du complexe)
# Markov O2 : pour chaque transition (genre_N-1, genre_N),
# récupère le genre_N+1 le plus probable.
# Lissage Laplace pour éviter proba=0 sur transitions non vues.
if len(history) >= 2:
    prev_prev_genre, prev_genre = history[-2]['genre'], history[-1]['genre']
    next_genre_prob = markov_o2.get((prev_prev_genre, prev_genre), {})
    # Fallback : si pas de transition vue, utiliser P(genre | prev_genre)
    if not next_genre_prob:
        next_genre_prob = markov_o1.get(prev_genre, {})
```

**Règle 5 : Commenter les limites et décisions de design**

```python
# ✅ BON (explique la limite)
def infer_genre_ollama(title: str, channel: str) -> str:
    """Auto-détecte le genre via Ollama.

    Note: Ollama (~7B) a du bruit (Lil Nas X → rap us au lieu de pop us).
    Mitigé par CHANNEL_GENRE_MAP (override curé) et fallback "autre".
    Pour améliorer : utiliser modèle plus gros ou fine-tuner sur dataset NeuroBeats.
    """
    # ...code...
```

**Règle 6 : Pas de commentaires d'état, use logs**

```python
# ❌ Mauvais
x = fetch_data()
# Données fetched, c'est ok
# Maintenant on les traite
process(x)

# ✅ Bon
logger.info("[fetch] données reçues")
x = fetch_data()
logger.debug(f"[process] {len(x)} items")
process(x)
```

### Documenter vs Commenter

| Quoi                      | Comment                        | Exemple                               |
| ------------------------- | ------------------------------ | ------------------------------------- |
| **Fonction publique**     | Docstring (numpy/google)       | `def get_recommendation()...`         |
| **Decision non-évidente** | Commentaire court POURQUOI     | `# Cache en RAM car coûte 14s`        |
| **Algo complexe**         | Commentaire étape par étape    | Markov O2, lissage Laplace            |
| **Bug/limite connue**     | Comment dans docstring + log   | `Note: inférence a du bruit...`       |
| **Code trivial**          | Rien (noms parlants suffisent) | `if user_exists: return user`         |
| **État du programme**     | Logs `[type]` pas commentaires | `logger.info("[reco] found 5 items")` |

### Format Docstrings NeuroBeats

**Style Google (recommandé pour NeuroBeats) :**

```python
def start_streaming(mood: str, force_genre: bool = True) -> None:
    """Lance un flux infini de musique basé mood.

    Boucle : recommandation → play → attente fin → recommandation.
    Gapless (loadfile replace via mpv IPC socket).
    Arrêtable via stop_streaming() ou lecture manuelle (kill le thread).

    Args:
        mood: Genre cible (ex. "rap fr", "pop us", "lofi", "dance")
        force_genre: Si True, 100% genre (RAG+Markov intra-genre)

    Raises:
        RuntimeError: Si daemon mpv mort ou pas accessible

    Examples:
        >>> start_streaming("rap fr", force_genre=True)
        # Lance Titre 1/∞ (GAZO - CARTIER), puis Titre 2/∞, etc.

    Notes:
        - Crée thread daemon unique (pas 2x streaming en parallèle)
        - Mood en RAM, pas persisté (reprise = relancer)
        - Prefetch N+1 en background
    """
```

### Checklist Pre-Code

[ ] Fonction publique a docstring (args, returns, raises, exemples)
[ ] Noms variables/fonctions explicites (pas x, y, data)
[ ] Commentaires = POURQUOI pas QUOI
[ ] Pas de commentaires = logs utilisent [type]
[ ] Algos complexes expliqués (Markov, RAG, etc.)
[ ] Limites/notes connues dans docstring
[ ] Pas de TODO/FIXME orphelins (ouvrir issue ou fix immédiatement)

### Conseil

**Code professionnel = lisible du 1er coup, sans commentaires verbeux.**
Un bon commentaire explique une décision tricky. Un mauvais répète le code.

---

## §59 — Runtime yt-dlp Android (module expo `ytdlp-react-native`)

### Vision (3 runtimes)

1. **Embarqué (pin, fallback offline)** : AAR local
   `dev.ffmpegkit-maintained:yt-dlp-android:2.0.3-neurobeats`
   (`yt_dlp` 2026.08.19 + `yt_dlp_ejs` 0.8.0, Python Chaquopy 17.0.0, x86_64 + arm64-v8a).
   Toujours présent ; sert en mode hors-ligne et en rollback.
2. **Live (auto-update PyPI)** : unzip wheels dans `files/ytdlp-live`, activé via
   `sys.path[0]` + purge de `sys.modules`. Persistant : ré-appliqué à chaque
   démarrage (`reapplyIfLive`) car `sys.path` est par-process. Tout échec →
   suppression de `ytdlp-live` (rollback silencieux vers l'embarqué).
3. **JS runtime (challenges EJS)** : QuickJS-ng ≥ 0.12.0
   (`quickjs` ≥ 2023.12.9), livré en `jniLibs` `libqjs.so`,
   injecté via `js_runtimes: {"quickjs": {"path": ...}}`.

### Règles d'écriture (NE PAS CASSER)

- **Interdiction de forcer `player_client`** (client YouTube = laissé à yt-dlp).
  Les stratégies vues en production : `web` + `web_embedded` (API player), `visionos`
  pour les flux avec PoToken. `extractor_args` du moteur sont le point unique d'ajustement.
- **Chemins avec espaces** : l'expéditeur doit remettre un `uri` encodé
  (`Uri.fromFile(...).toString()`) car `Paths.join` d'expo-file-system n'encode que
  les segments ≥ 2 (le `file://` brut du 1er argument rejette les espaces nativement).
  Toute copie d'un fichier téléchargé doit utiliser `new File(uri ?? path ?? "")`.
- **Ne pas striper les `build/*.d.ts|.js`** : les types/facades `build/` sont committés
  (TS sert les types depuis `build/`). Toute API native ajoutée doit mettre à jour
  `build/YtDlp.js`, `build/index.js`, `build/index.d.ts`, `build/errors.js`,
  `build/types.d.ts` (codes erreur) + facade web `ExpoYtDlpModule.web.js`.

### Auto-updater (contrat)

- `updateYtDlp()` → `{action: "up_to_date" | "updated", version}`. Comparaison PEP 440
  normalisée (`2026.08.19` == `2026.8.19`, PyPI normalise les zéros).
- Codes : `BUSY` (un download actif), `UPDATE_NETWORK`, `UPDATE_FAILED`.
- Wheel cible : `yt_dlp-<version-pypi>-py3-none-any.whl` ; ejs épinglé lu dans
  `requires-dist` du METADATA (`yt-dlp-ejs==X.Y.Z`). SHA-256 vérifié avant unzip.
- Déclencheur app : échec de transfert sur `NETWORK_ERROR` → `updateYtDlp()` en fond,
  une seule tentative ; l'utilisateur est informé du résultat.
- Rebuild du pin : depuis `$HOME/python` (cpython-build-standalone 3.13.2),
  `./gradlew :library:publishToMavenLocal --no-daemon -x test`.

---
