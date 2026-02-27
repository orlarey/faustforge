# Spécification : faustforge — Service Faust Web (aligné implémentation)

## Scénario de référence

Un programmeur Faust ouvre l’interface web de faustforge. Un overlay d’accueil
(`WELCOME TO FAUSTFORGE`) apparaît au-dessus d’une session showcase dont les vues
défilent automatiquement. Il clique sur **ENTER** pour déverrouiller l’audio
(contrainte WebAudio du navigateur) et revenir à la session vide.

À l’écran, la session est vide et un message central l’invite à déposer un fichier `.dsp`.
Il fait un drag & drop ou colle du code.

Le service calcule le SHA‑1 du contenu. Si une session avec ce SHA‑1 existe déjà,
elle est réutilisée. Sinon, une session est créée et une analyse est lancée pour
générer le C++ et les diagrammes SVG.

Le programmeur navigue entre les vues **dsp**, **svg**, **run**, **cpp**, **tasks** et **signals**.
La barre d’en‑tête permet de parcourir l’historique des sessions (flèches `◀/▶`),
d’ouvrir un sélecteur de sessions (recherche + saut direct), de choisir l’ordre
(`chronological` ou `usage`), de supprimer la session courante et de télécharger
les artefacts correspondant à la vue affichée.

Dans la vue **Run**, le DSP est compilé côté navigateur via FaustWASM pour produire
l’interface utilisateur; l’audio peut ensuite être démarré/arrêté sans faire disparaître
l’UI. Pour l’export, l’utilisateur peut télécharger l’application PWA (zip).

Par défaut, il n’y a pas de limite de sessions (`MAX_SESSIONS=0`).
Une limite optionnelle peut être réactivée via configuration (`MAX_SESSIONS>0`).

## Scénario MCP (assistant IA)

Un assistant IA est connecté au service via MCP et partage l’espace de sessions avec
l’utilisateur web.

1. **Découverte**  
   L’IA récupère l’état courant (session active, vue active). Si la session est vide,
   elle propose un exemple minimal pour démarrer.

2. **Soumission**  
   L’IA soumet un nouveau code Faust (équivalent au drop d’un fichier `.dsp`). Le serveur
   crée ou réutilise la session, puis déclenche l’analyse (C++/SVG).

3. **Navigation / lecture**  
   L’IA choisit la vue (`dsp`, `svg`, `run`, `cpp`, `tasks`, `signals`) et récupère le contenu correspondant
   pour analyse ou diagnostic.

4. **Itération**  
   L’IA propose une correction ou une amélioration, soumet un nouveau code, puis compare
   les artefacts (C++/SVG) afin de valider l’effet.

5. **Exécution**  
   Si l’utilisateur souhaite tester, l’IA bascule sur la vue **Run** et invite à démarrer
   l’audio dans le navigateur.

## Scénario sessions statiques / live

Objectif : conserver le modèle immuable par SHA‑1 tout en supportant l’édition live d’un fichier local.

### Types de session

- **Session statique** :
  - créée par `drag & drop` ou `paste`
  - identifiant = `sha1(contenu)`
  - immuable (modification de contenu => autre session statique)

- **Session live** :
  - créée par `open file` (chemin local explicite)
  - identifiant stable lié au fichier (format `live-<hash(path canonique)>`)
  - mutable : suit les sauvegardes externes du fichier

### Stockage disque

- dossier unique `sessions/`
- une session = un sous-dossier nommé par son identifiant:
  - statique: `<sha1>`
  - live: `live-<hash>`
- distinction par `metadata.json.kind` (`static` ou `live`)
- l’ordre chronologique est reconstruit au démarrage en scannant `sessions/*/metadata.json`

### Règles de fonctionnement

1. Lors d’un `save` externe d’une session live :
   - relire le fichier `.dsp`
   - recalculer `sha1(contenu)`
   - si le SHA est inchangé : ne rien faire
   - sinon : recompiler et mettre à jour les artefacts de la session live

2. Session active :
   - avec `LIVE_AUTO_DISCOVER=1`, la découverte/modification d’un fichier `.dsp` peut
     le rendre actif automatiquement dans l’UI
   - avec `LIVE_AUTO_DISCOVER=0`, aucune bascule automatique n’est effectuée
   - le bouton refresh manuel reste disponible

3. Promotion live -> statique :
   - action utilisateur `freeze/promote`
   - crée (ou réutilise) la session statique `sha1(contenu courant)`
   - la session live peut rester ouverte

4. Robustesse :
   - fichier déplacé/supprimé => session live `broken` + action `Relink`
   - sauvegardes rapides => debounce + politique `latest wins`

### Invariants additionnels

```text
INV-LIVE-1 : Une session live correspond à un seul chemin canonique de fichier.
INV-LIVE-2 : Deux sessions live ne peuvent pas pointer vers le même chemin canonique.
INV-LIVE-3 : Une session statique reste strictement immuable.
```

## Workflow Docker (conteneur unique)

Objectif : exécuter l’interface web, l’API et le serveur MCP dans un seul conteneur,
avec Docker comme unique prérequis côté utilisateur.

### Démarrage par l’utilisateur

Commande de lancement :

```bash
docker run -d \
  --name faustforge \
  -p 3000:3000 \
  -v "$HOME/.faustforge/sessions:/app/sessions" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SESSIONS_DIR=/app/sessions \
  -e HOST_SESSIONS_DIR="$HOME/.faustforge/sessions" \
  -e FAUST_HTTP_URL=http://localhost:3000 \
  faustforge:latest
```

Après démarrage :
- l’interface web est disponible sur `http://localhost:3000`
- les sessions sont persistées dans `~/.faustforge/sessions`

### Connexion Claude Desktop (MCP en stdio via docker exec)

Configuration MCP (extrait) :

```json
{
  "mcpServers": {
    "faustforge": {
      "command": "docker",
      "args": ["exec", "-i", "faustforge", "node", "/app/mcp.mjs"]
    }
  }
}
```

### Contraintes et comportement

- Le conteneur doit être démarré avant la connexion MCP.
- Le serveur MCP n’écrit pas directement sur disque : il utilise l’API HTTP interne.
- Le port exposé est `3000` (UI + API).
- La compilation C++ est déléguée à un conteneur Docker Faust appelé par `faustforge`.
- Le runtime Docker de l’hôte doit donc être accessible depuis `faustforge` pour lancer ce conteneur de compilation.
- `HOST_SESSIONS_DIR` doit référencer le chemin hôte correspondant à `SESSIONS_DIR` pour les montages Docker imbriqués.
- Cela implique le montage de `/var/run/docker.sock` dans `faustforge` (impact sécurité à documenter).
- Nom d’image cible à terme : `ghcr.io/orlarey/faustforge:latest`.

---

## Vocabulaire du domaine

- **Code Faust** : programme source Faust (texte UTF‑8, extension `.dsp`).
- **Session** : répertoire de travail identifié par le SHA‑1 du code soumis.
- **SHA‑1** : empreinte hexadécimale de 40 caractères servant d’identifiant de session.
- **Artefact** : fichier généré par le service (C++, SVG, WASM, webapp, zip).
- **Vue** : mode d’affichage actif (`dsp`, `svg`, `run`, `cpp`, `tasks`, `signals`).
- **Webapp PWA** : application web générée par `faust2wasm-ts -pwa`.
- **Téléchargement** : action permettant d’exporter l’artefact lié à la vue courante.
- **Cap de sessions** : limite optionnelle de rétention configurée par `MAX_SESSIONS`.

---

## Modèle de domaine

### Types primitifs

```text
SHA1     = String[40]         -- empreinte hexadécimale
Code     = String             -- code source Faust (UTF-8)
Path     = String             -- chemin relatif dans la session
Bytes    = ByteArray          -- données binaires
View     = "dsp" | "svg" | "run" | "cpp" | "tasks" | "signals"
```

### Modèle formel de synchronisation des paramètres Run

Hypothèse: tous les acteurs partagent la même horloge (timestamps comparables).
Acteurs:
- `DSP` (source de vérité)
- `UI visuelles` (regular, orbit)
- `UI headless` (MCP), traitée comme une UI normale sans rendu graphique

#### Types

```text
ParamId    = Path
Value      = Number
Timestamp  = Number          -- ms epoch
UIId       = String

ParamCell ::= {
  v : Value,                 -- valeur canonique courante
  d : Timestamp,             -- date de dernière écriture acceptée
  owner : UIId | ⊥           -- UI détentrice du contrôle exclusif (⊥ = libre)
}

DSPState ::= {
  params : Map<ParamId, ParamCell>
}

UIState ::= {
  id     : UIId,
  params : Map<ParamId, ParamCell>,
  drag   : Set<ParamId>          -- paramètres localement manipulés
}
```

#### Opérations abstraites (sans contrainte de transport)

```text
ReadSnapshot() -> DSPState

SubmitDelta(uiId, updates, lockOps) -> Unit
  where updates : Map<ParamId, ParamCell>
        lockOps : {
          acquire : Set<ParamId>,
          release : Set<ParamId>
        }
```

`ReadSnapshot` et `SubmitDelta` peuvent être implémentés en appels de fonctions,
messages IPC, HTTP, etc. La spécification est indépendante du transport.

#### Boucle de synchronisation côté UI

Pour une UI `u`, cycle périodique:

```text
U1. S := ReadSnapshot()

U2. Merge entrant (DSP -> UI):
    pour chaque paramètre p:
      si S.params[p].d > u.params[p].d alors
        u.params[p] := S.params[p]

U3. Construction du delta sortant (UI -> DSP):
    updates[p] est émis seulement si:
      a) u.params[p].d > S.params[p].d
      b) (S.params[p].owner = ⊥) ou (S.params[p].owner = u.id)

U4. Submit:
    SubmitDelta(u.id, updates, lockOps)
```

#### Règles d’application côté DSP

Pour chaque update `(p, cell)` reçu de `ui` (avec `v = cell.v`, `d = cell.d`):

```text
D1 (arbitrage lock):
  accepter seulement si DSP.params[p].owner = ⊥ ou DSP.params[p].owner = ui

D2 (fraîcheur):
  accepter seulement si d >= DSP.params[p].d

D3 (bornage):
  v' = clamp(v, min(p), max(p))

D4 (commit):
  DSP.params[p].v := v'
  DSP.params[p].d := d
```

Gestion des locks:

```text
L1: acquire(p) par ui
    si DSP.params[p].owner = ⊥ ou DSP.params[p].owner = ui,
    alors DSP.params[p].owner := ui

L2: release(p) par ui
    si DSP.params[p].owner = ui, alors DSP.params[p].owner := ⊥
```

Pendant qu’un paramètre `p` est locké par `uiA`, toute mise à jour provenant d’une autre
UI `uiB != uiA` est ignorée pour `p`.

#### Invariants

```text
INV-RUN-1 : Le DSP est la source de vérité: pour tout p, DSP.params[p].v est la valeur effective.
INV-RUN-2 : Pour tout p, DSP.params[p].v ∈ [min(p), max(p)].
INV-RUN-3 : Si DSP.params[p].owner = uiX, alors toute écriture de uiY != uiX sur p est rejetée.
INV-RUN-4 : Monotonicité: pour tout p, DSP.params[p].d ne décroît jamais.
INV-RUN-5 : Convergence: en absence de nouvelles écritures, toute UI converge vers ReadSnapshot().
```

### Structure d’une session

```text
Session ::= {
  sha1          : SHA1,
  filename      : String,        -- nom original du fichier .dsp
  sourcecode/   : Directory,     -- contient <filename>.dsp
  user_code.dsp : File,          -- copie standardisée
  metadata.json : File,          -- métadonnées de session
  generated.cpp : File?,         -- C++ généré (après analyse)
  errors.log    : File,          -- log d’erreurs (peut être vide)
  svg/          : Directory?,    -- diagrammes SVG (après analyse)
  wasm/         : Directory?,    -- WASM produit côté serveur (optionnel)
  webapp/       : Directory?     -- PWA générée (optionnel)
}
```

### Métadonnées de session

```text
SessionMeta ::= {
  sha1             : SHA1,
  filename         : String,
  compilation_time : Timestamp
}
```

---

## Invariants

```text
INV-1 : ∀ s ∈ Sessions : |s.sha1| = 40 ∧ s.sha1 ∈ [0-9a-f]*
INV-2 : ∀ s ∈ Sessions : sha1(content(s.user_code.dsp)) = s.sha1
INV-3 : ∀ s₁, s₂ ∈ Sessions : s₁.sha1 = s₂.sha1 ⇒ s₁ = s₂
INV-4 : |Sessions| ≤ MaxSessions
```

---

## Opérations

### O‑1 : Soumission de code (analyse automatique)

```text
S⟦submit⟧ : (Code × Filename) → (SHA1 × Errors)

Précondition  : code ≠ "" ∧ filename termine par ".dsp"
Postcondition :
  let sha = sha1(code) in
  let s = Sessions[sha] in
  if s = ⊥ then
    Sessions' = Sessions ∪ { createSession(sha, code, filename) }
    ∧ s.sourcecode/<filename> = code
    ∧ s.user_code.dsp = code
    ∧ s.metadata.json = { sha1, filename, now() }
    ∧ docker_run(s.sourcecode, filename, "-o", "../generated.cpp", "-svg")
    ∧ s.errors.log = stderr de l'exécution
    ∧ s.svg/ = diagrammes générés (si pas d'erreur)
  else
    touch(s)
  ∧ result = (sha, content(s.errors.log))
```

### O‑2 : Compilation WebAssembly (serveur)

```text
W⟦compile⟧ : SHA1 → Result<(), Errors>

Précondition  : sha ∈ Sessions ∧ Sessions[sha].errors.log = ""
Postcondition :
  let s = Sessions[sha] in
  docker_run(s.sourcecode, s.filename, "-lang", "wasm", "-o", "../wasm/main.wasm")
  ∧ s.wasm/ = module WASM généré
  ∧ result = Ok(()) si succès, Err(errors) sinon
```

### O‑3 : Génération webapp PWA (serveur)

```text
P⟦webapp⟧ : SHA1 → Result<(), Errors>

Précondition  : sha ∈ Sessions
Postcondition :
  let s = Sessions[sha] in
  faust2wasm-ts(s.filename, "../webapp", "-pwa")
  ∧ s.webapp/ = webapp générée si succès
```

### O‑4 : Récupération d’artefact

```text
G⟦get⟧ : SHA1 × Path → Result<Bytes, NotFound>
```

### O‑5 : Liste des diagrammes SVG

```text
L⟦listSVG⟧ : SHA1 → Result<List<String>, NotFound>
```

### O‑6 : Liste des sessions (ordre configurable)

```text
L⟦sessions⟧ : (order?: "chronological" | "usage") → List<SessionMeta>
```

### O‑7 : Suppression d’une session

```text
D⟦delete⟧ : SHA1 → Result<(), NotFound>
```

### O‑8 : Téléchargements

```text
T⟦download⟧ : (SHA1 × View) → Result<Bytes, NotFound>

Vue "dsp"  → user_code.dsp
Vue "cpp"  → generated.cpp
Vue "svg"  → tar.gz(svg/)
Vue "run"  → tar.gz(webapp/)
Vue "tasks" → tasks.dot
Vue "signals" → signals.dot
```

### O‑8bis : Presets d’options de compilation C++ (vue cpp)

Objectif: rendre visible l’effet des options Faust sur `generated.cpp`.

Règles UX:

1. La zone d’édition des options en vue `cpp` affiche toujours les options ayant servi
   à générer le C++ actuellement affiché.
2. `Enter` dans cette zone déclenche une recompilation C++ avec les options saisies.
3. Les options sont normalisées par compactage des espaces:
   - trim début/fin
   - remplacement des séquences d’espaces par un espace unique
4. L’identité d’un preset est la chaîne normalisée.
5. Deux presets de contenu identique fusionnent en un seul preset (unicité forte).
6. Les presets sont ordonnés par récence d’usage (`lastUsedAt` décroissant).
7. Un preset invalidé (échec de compilation avec ce DSP déjà valide en défaut)
   est refusé en application tant qu’il n’est pas modifié.
8. Un preset non valide ne doit jamais devenir le preset actif affiché.

Modèle minimal:

```text
CppPreset ::= {
  flags      : String,             -- forme normalisée, identité du preset
  status     : "valid" | "invalid",
  lastUsedAt : Number              -- ms epoch
}
```

Opération API dédiée:

```text
W⟦compile_cpp_with_flags⟧ : (SHA1 × flags:String) → Result<(), Errors>
```

Effets:
- sur succès: `generated.cpp` est remplacé par la version compilée avec `flags`
- sur échec: `generated.cpp` affiché reste inchangé

Précondition fonctionnelle:
- La session DSP courante est déjà valide avec les options par défaut.

### O‑9 : Version du compilateur

```text
V⟦version⟧ : () → String
```

---

## Services MCP

### MCP‑1 : submit (soumission de code)

```text
mcp.submit : (Code × Filename? × persistOnSuccessOnly?: Bool) → { sha1: SHA1, errors: String, persisted: Bool }

Préconditions :
  - code ≠ ""
  - filename, si fourni, termine par ".dsp"

Effets :
  - Soumission via API HTTP interne
  - Déclenche l’analyse C++/SVG si nécessaire
  - Si filename est absent, le service génère un nom automatique :
    "ai-<yyyymmddhhmmss>.dsp"
  - persistOnSuccessOnly :
    - true  : persiste uniquement si l’analyse réussit
    - false : comportement équivalent au drop utilisateur
  - Valeur par défaut côté MCP : true

Résultat :
  - sha1 : identifiant de session
  - errors : contenu de errors.log (chaîne vide si succès)
  - persisted : true si la session est mémorisée, false sinon
```

### MCP‑2 : get_errors (récupération du log d’erreurs)

```text
mcp.get_errors : (SHA1) → { sha1: SHA1, errors: String }

Préconditions :
  - sha1 ∈ Sessions

Effets :
  - Aucun (lecture)

Résultat :
  - sha1 : identifiant de session
  - errors : contenu de errors.log (chaîne vide si succès)
```

### MCP‑3 : get_state (état courant)

```text
mcp.get_state : () → { sha1: SHA1?, filename: String?, view: View }

Préconditions :
  - Aucune

Effets :
  - Aucun (lecture)

Résultat :
  - sha1 : session courante (null si session vide)
  - filename : nom du fichier source (null si session vide)
  - view : vue courante (\"dsp\" | \"cpp\" | \"svg\" | \"run\" | \"signals\" | \"tasks\")
```

### MCP‑3b : get_session (session courante)

```text
mcp.get_session : () → { sha1: SHA1?, filename: String? }

Préconditions :
  - Aucune

Effets :
  - Aucun (lecture)

Résultat :
  - sha1 : session courante (null si session vide)
  - filename : nom du fichier source (null si session vide)
```

### MCP‑4 : get_view_content (contenu de la vue courante)

```text
mcp.get_view_content : () → Result<{ view: View, mime: String, content: Bytes }, NotFound>

Préconditions :
  - Une session est active

Effets :
  - Aucun (lecture)

Résultat :
  - view : vue courante
  - mime : type MIME du contenu
  - content : contenu binaire/texte correspondant à la vue

Règles de contenu :
  - view = \"dsp\" → user_code.dsp (text/plain)
  - view = \"cpp\" → generated.cpp (text/plain)
  - view = \"svg\" → process.svg si présent, sinon 1er SVG (image/svg+xml)
  - view = \"run\" → dernier snapshot de spectre si disponible (application/json)
  - view = \"signals\" → signals.dot (text/vnd.graphviz)
  - view = \"tasks\" → tasks.dot (text/vnd.graphviz)
```

### MCP‑5 : set_view (changement de vue)

```text
mcp.set_view : (View) → { view: View }

Préconditions :
  - view ∈ { \"dsp\", \"cpp\", \"svg\", \"run\", \"signals\", \"tasks\" }

Effets :
  - Met à jour la vue courante côté UI

Résultat :
  - view : nouvelle vue courante
```

### MCP‑6 : list_sessions (liste des sessions)

```text
mcp.list_sessions : () → { sessions: List<SessionMeta> }

Préconditions :
  - Aucune

Effets :
  - Aucun (lecture)

Résultat :
  - sessions : liste ordonnée par date de création (anciennes → récentes)
```

### MCP‑7 : set_session (changement de session)

```text
mcp.set_session : (SHA1) → { sha1: SHA1, filename: String }

Préconditions :
  - sha1 ∈ Sessions

Effets :
  - Met à jour la session courante côté UI

Résultat :
  - sha1, filename de la session activée
```

### MCP‑8 : prev_session

```text
mcp.prev_session : () → { sha1: SHA1?, filename: String? }

Préconditions :
  - Aucune

Effets :
  - Déplace la session courante vers la précédente (ordre de création)

Résultat :
  - sha1, filename de la session activée (null si session vide)
```

### MCP‑9 : next_session

```text
mcp.next_session : () → { sha1: SHA1?, filename: String? }

Préconditions :
  - Aucune

Effets :
  - Déplace la session courante vers la suivante (ordre de création), ou session vide

Résultat :
  - sha1, filename de la session activée (null si session vide)
```

### MCP‑10 : get_spectrum (contenu spectral courant)

```text
mcp.get_spectrum : () → { mime: \"application/json\", content: SpectrumSummary | SpectrumSnapshot }

Préconditions :
  - Aucune stricte (retourne erreur si aucun snapshot)

Effets :
  - Aucun (lecture)

Résultat :
  - content : dernier contenu spectral poussé par la vue run
    - priorité : SpectrumSummary (spectrum_summary_v1)
    - fallback de transition : SpectrumSnapshot legacy (FFT brut)
  - peut inclure `audioQuality` (extension v1 optionnelle) :
    - saturation/clipping (`peakDbFSQ`, `clipSampleCount`, `clipRatioQ`)
    - défauts temporels (`clickCount`, `clickScoreQ`)
```

### MCP‑11 : get_run_ui (structure UI run)

```text
mcp.get_run_ui : () → { sha1: SHA1, ui: Json }

Préconditions :
  - Une session active en état partagé

Effets :
  - Aucun (lecture)

Résultat :
  - ui : JSON de structure Faust UI (paths exploitables par set_run_param)
```

### MCP‑12 : get_run_params (valeurs courantes run)

```text
mcp.get_run_params : () → { sha1: SHA1, params: Map<Path, Number> }

Préconditions :
  - Une session active en état partagé

Effets :
  - Aucun (lecture)
```

### MCP‑13 : set_run_param (écriture d’un paramètre run)

```text
mcp.set_run_param : (path: Path, value: Number) → { sha1: SHA1, path: Path, value: Number }

Préconditions :
  - Une session active en état partagé

Effets :
  - Écrit la valeur dans l’état run partagé (runParams)
  - La vue run applique cette valeur côté DSP/UI via sa boucle de synchronisation

Comportement par type de paramètre :
  - hslider, vslider, nentry : valeur persistante jusqu’au prochain changement
  - button : nécessite un cycle 1 puis 0 pour retrigger correctement
  - checkbox : toggle 0/1 persistant
```

### MCP‑13bis : set_run_param_and_get_spectrum

```text
mcp.set_run_param_and_get_spectrum :
  (path: Path, value: Number, settleMs?: Int, captureMs?: Int, sampleEveryMs?: Int, maxFrames?: Int)
  → {
      path: Path,
      value: Number,
      settleMs: Int,
      captureMs: Int,
      sampleEveryMs: Int,
      series: List<{ tMs: Int, summary: SpectrumSummary }>,
      aggregate: { mode: \"max_hold\", summary: SpectrumSummary }
    }

Préconditions :
  - Une session active en état partagé
  - path pointe un paramètre continu (slider/nentry/checkbox)

Effets :
  - Force la vue partagée sur \"run\" avant capture
  - Démarre l’audio si nécessaire
  - Applique set_run_param(path, value)
  - Attend settleMs (défaut 120 ms) pour laisser le DSP se stabiliser
  - Capture une série temporelle de SpectrumSummary sur captureMs
  - Retourne aussi un agrégat max-hold sur la fenêtre
  - La fenêtre de capture commence après l’attente settleMs
```

### MCP‑13ter : get_polyphony / set_polyphony

```text
mcp.get_polyphony : () → { sha1: SHA1, voices: Int }
mcp.set_polyphony : (voices: Int) → { sha1: SHA1, voices: Int }

Préconditions :
  - Une session active en état partagé

Règles :
  - Convention : voices=0 => mode mono
  - Valeurs autorisées : 0, 1, 2, 4, 8, 16, 32, 64

Effets :
  - set_polyphony force la vue partagée sur "run"
  - La vue run recompile le DSP dans le mode demandé
  - Le mode courant est reflété dans l’état partagé (runPolyphony)
```

### MCP‑13quater : midi_note_on / midi_note_off / midi_note_pulse

```text
mcp.midi_note_on : (note: Int[0..127], velocity?: Number[0..1]) → { sha1: SHA1, midi: Json, sent: Json }
mcp.midi_note_off : (note: Int[0..127]) → { sha1: SHA1, midi: Json, sent: Json }
mcp.midi_note_pulse : (note: Int[0..127], velocity?: Number[0..1], holdMs?: Int[1..5000]) → { sha1: SHA1, midi: Json, sent: Json }

Préconditions :
  - Une session active en état partagé
  - Audio déverrouillé (clic **ENTER** validé dans l’UI)

Effets :
  - Force la vue partagée sur "run"
  - Démarre l’audio si nécessaire (note_on / note_pulse)
  - Publie une commande MIDI atomique dans l’état partagé (runMidi + nonce)
  - La vue run exécute la commande exactement une fois par nonce

Notes :
  - Le mode polyphonique est généralement requis pour un comportement MIDI musical complet.
  - En fallback, la vue run peut mapper MIDI sur des paramètres (gate/freq/key/gain) si disponibles.
```

### MCP‑14 : run_transport (start/stop/toggle audio)

```text
mcp.run_transport : (action: \"start\" | \"stop\" | \"toggle\") → { sha1: SHA1, runTransport: { action, nonce } }

Préconditions :
  - Une session active en état partagé

Effets :
  - Force la vue partagée sur \"run\" avant publication de la commande
  - Publie une commande transport run (avec nonce)
  - La vue run exécute la commande exactement une fois par nonce
```

### MCP‑15 : trigger_button (cycle atomique press/release)

```text
mcp.trigger_button : (path: Path, holdMs?: Int) → { path: Path, holdMs: Int, triggered: Bool }

Préconditions :
  - path pointe un paramètre bouton

Effets :
  - Force la vue partagée sur \"run\" avant trigger
  - Démarre l’audio si nécessaire
  - Déclenche un événement runTrigger atomique (press=1, attente, release=0)
```

### MCP‑16 : trigger_button_and_get_spectrum

```text
mcp.trigger_button_and_get_spectrum :
  (path: Path, holdMs?: Int, captureMs?: Int, sampleEveryMs?: Int, maxFrames?: Int)
  → {
      path: Path,
      holdMs: Int,
      captureMs: Int,
      sampleEveryMs: Int,
      series: List<{ tMs: Int, summary: SpectrumSummary }>,
      aggregate: { mode: \"max_hold\", summary: SpectrumSummary }
    }

Préconditions :
  - path pointe un paramètre bouton

Effets :
  - Force la vue partagée sur \"run\" avant trigger/capture
  - Démarre l’audio si nécessaire
  - Déclenche runTrigger atomique (press/release)
  - Capture une série temporelle de SpectrumSummary
  - Retourne aussi un agrégat max-hold sur la fenêtre
  - La fenêtre de capture commence à l’instant d’appel (pas de snapshots anciens)

But :
  - Fiabiliser l’analyse IA des sons transitoires (percussifs), en évitant les erreurs de timing entre trigger et capture.
```

### MCP‑17 : get_audio_snapshot (compatibilité)

```text
mcp.get_audio_snapshot : (duration_ms?: Int, format?: \"wav\" | \"pcm\") → { mime: \"application/json\", content: SpectrumSummary | SpectrumSnapshot }

Préconditions :
  - Aucune stricte (retourne erreur si aucune donnée spectrale)

Effets :
  - Aucun (lecture)

Résultat :
  - Alias de compatibilité de get_spectrum pour certains clients IA
  - Le rendu audio brut (wav/pcm) n’est pas implémenté
```

## Boucle IA Run (pilotage + capture)

```text
Boucle recommandée pour interaction IA :

1) set_view(\"run\")
2) get_run_ui()              -- découverte des paths
3) get_polyphony() / set_polyphony(voices)
4) run_transport(\"start\")   -- audio ON
5) set_run_param(...)        -- réglages continus
6) set_run_param_and_get_spectrum(path, value, settleMs, captureMs)
7) trigger_button_and_get_spectrum(path, holdMs, captureMs)
8) midi_note_on/off/pulse(...) selon le cas
9) analyser series + aggregate.summary
10) itérer les paramètres puis recapturer
```

Contraintes temporelles :
- Les paramètres continus passent par runParams (état persistant).
- runParamsUpdatedAt versionne les paramètres partagés pour éviter les rollbacks en cas d'interactions UI/IA concurrentes.
- Les triggers boutons passent par runTrigger (événement avec nonce).
- Le contenu spectral est poussé périodiquement par la vue run (summary prioritaire), puis agrégé côté MCP pendant `captureMs`.
- Le résumé spectral peut inclure un feedback qualité audio (`audioQuality`) pour détecter clicks et saturation.

### Note : pas de suppression via MCP

```text
La suppression de session est volontairement réservée à l’UI.
Le protocole MCP n’expose pas d’opération de suppression.
```

## Comportement UI (synthèse)

- **Session vide** : message central “Drop a .dsp file here”, création par drop ou paste.
- **Navigation** : précédent/suivant selon l’ordre actif (`chronological` ou `usage`).
- **Run** : compilation côté navigateur via FaustWASM (libfaust‑wasm servi localement) ;
  l’UI reste visible quand l’audio est arrêté.
- **Compromis d’exécution** : les artefacts d’analyse (C++, SVG, PWA) sont générés côté serveur,
  tandis que l’exécution audio et l’UI interactive se font côté navigateur.
- **Download** : export dépendant de la vue courante.
- **Delete** : suppression de la session courante via icône poubelle.

---

## Évolution Et Migration

Le service doit rester évolutif quand de nouvelles vues ou une nouvelle version du compilateur Faust sont introduites.

Principes:
- Une session existante peut ne pas contenir les nouveaux artefacts attendus (ex: `signals.dot` ajouté après coup).
- L'UI doit gérer explicitement ce cas (`artefact non disponible`) sans casser la navigation.
- Le système doit prévoir un mécanisme de régénération des artefacts d'une session existante.

Pistes de mise en oeuvre (à prioriser ultérieurement):
- Ajouter une version d'artefacts de session dans `metadata.json` (ex: `artifactsVersion`, `faustVersion`).
- Détecter les sessions obsolètes et proposer/réaliser une régénération à la demande.
- Exposer une opération API/MCP dédiée à la régénération (`reanalyze` / `upgrade session`).
- Documenter la compatibilité ascendante par vue (quels artefacts sont requis).

Objectif:
- permettre à faustforge d'évoluer (nouvelles vues, évolution compilateur) sans invalider les sessions historiques.
