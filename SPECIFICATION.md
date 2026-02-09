# Spécification : faustforge — Service Faust Web (aligné implémentation)

## Scénario de référence

Un programmeur Faust ouvre l’interface web de faustforge. À l’écran, la session est vide
et un message central l’invite à déposer un fichier `.dsp`. Il fait un drag & drop
ou clique pour sélectionner un fichier.

Le service calcule le SHA‑1 du contenu. Si une session avec ce SHA‑1 existe déjà,
elle est réutilisée. Sinon, une session est créée et une analyse est lancée pour
générer le C++ et les diagrammes SVG.

Le programmeur navigue entre les vues **DSP**, **C++**, **Diagrams** et **Run**.
La barre d’en‑tête permet de parcourir l’historique des sessions (ordre de création),
de supprimer la session courante et de télécharger les artefacts correspondant à la
vue affichée.

Dans la vue **Run**, le DSP est compilé côté navigateur via FaustWASM pour produire
l’interface utilisateur; l’audio peut ensuite être démarré/arrêté sans faire disparaître
l’UI. Pour l’export, l’utilisateur peut télécharger l’application PWA (zip).

Le cache de sessions est borné par une politique LRU: les sessions les moins récemment
accédées sont supprimées lorsque la limite est atteinte.

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
   L’IA choisit la vue (DSP, C++, Diagrams, Run) et récupère le contenu correspondant
   pour analyse ou diagnostic.

4. **Itération**  
   L’IA propose une correction ou une amélioration, soumet un nouveau code, puis compare
   les artefacts (C++/SVG) afin de valider l’effet.

5. **Exécution**  
   Si l’utilisateur souhaite tester, l’IA bascule sur la vue **Run** et invite à démarrer
   l’audio dans le navigateur.

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
- **Vue** : mode d’affichage actif (DSP, C++, Diagrams, Run).
- **Webapp PWA** : application web générée par `faust2wasm-ts -pwa`.
- **Téléchargement** : action permettant d’exporter l’artefact lié à la vue courante.
- **Cache LRU** : politique de rétention par ordre d’accès récent.

---

## Modèle de domaine

### Types primitifs

```text
SHA1     = String[40]         -- empreinte hexadécimale
Code     = String             -- code source Faust (UTF-8)
Path     = String             -- chemin relatif dans la session
Bytes    = ByteArray          -- données binaires
View     = "dsp" | "cpp" | "svg" | "run"
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

### O‑6 : Liste des sessions (ordre de création)

```text
L⟦sessions⟧ : () → List<SessionMeta>
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
Vue "svg"  → zip(svg/)
Vue "run"  → zip(webapp/)
```

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
  - view : vue courante (\"dsp\" | \"cpp\" | \"svg\" | \"run\")
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
```

### MCP‑5 : set_view (changement de vue)

```text
mcp.set_view : (View) → { view: View }

Préconditions :
  - view ∈ { \"dsp\", \"cpp\", \"svg\", \"run\" }

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
  - Déplace la session courante vers la suivante (ordre de création) ou session vide

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
3) run_transport(\"start\")   -- audio ON
4) set_run_param(...)        -- réglages continus
5) set_run_param_and_get_spectrum(path, value, settleMs, captureMs)
6) trigger_button_and_get_spectrum(path, holdMs, captureMs)
7) analyser series + aggregate.summary
8) itérer les paramètres puis recapturer
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

- **Session vide** : message central “Drop a .dsp file here”, clic pour sélectionner un fichier.
- **Navigation** : précédent/suivant par ordre de création.
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
