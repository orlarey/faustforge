# Spécification : Plugin VSCode faustforge

## Scénario de référence

Un utilisateur ouvre un projet DSP dans VSCode et lance la commande
`Faustforge: Connect`.

Le plugin détecte l’instance faustforge (HTTP local), puis:
1. crée/met à jour une session live depuis le fichier `.dsp` actif,
2. bascule faustforge sur cette session,
3. ouvre la vue demandée (`dsp`, `run`, etc.).

Lors des sauvegardes dans VSCode, le fichier live est déjà suivi par faustforge:
les artefacts se mettent à jour automatiquement (mécanisme live existant).

## Objectif

Fournir une intégration native VSCode pour réduire la friction entre édition locale
et exploration faustforge (UI web + MCP), sans dépendre d’URI externes.

## Périmètre MVP

Fonctionnalités MVP:
- connexion à faustforge via HTTP (`FAUSTFORGE_URL`, défaut `http://localhost:3000`),
- commande d’édition d’une session statique en live (`Edit in VSCode`),
- synchronisation de session courante (`set_session`) et vue (`set_view`),
- actions rapides: refresh, run start/stop, ouverture navigateur.

Hors MVP:
- sync temps réel bidirectionnelle fine (WebSocket),
- édition collaborative multi-utilisateur,
- contrôle Orbit avancé depuis VSCode.

## Vocabulaire

- **Extension host**: runtime Node de VSCode extension.
- **Document actif**: fichier `.dsp` actuellement focalisé.
- **Connexion faustforge**: disponibilité API HTTP + version.
- **Contexte session**: `{ sha1, filename, kind, view }`.

## Types

```text
ForgeUrl      = String
SessionId     = SHA1 | LiveId
LiveId        = "live-" + SHA1
View          = "dsp" | "svg" | "run" | "cpp" | "tasks" | "signals"

PluginConfig ::= {
  forgeUrl: ForgeUrl,
  autoOpenRunOnBuild: Bool,
  autoSyncActiveDsp: Bool
}

ConnectionState ::= {
  reachable: Bool,
  appVersion?: String,
  faustVersion?: String
}
```

## Invariants

```text
INV-VSC-1 : Le plugin n’écrit jamais hors workspace utilisateur.
INV-VSC-2 : Toute action session cible une session existante ou explicitement créée.
INV-VSC-3 : Les erreurs réseau sont non bloquantes pour l’éditeur (toast + log).
INV-VSC-4 : Les opérations plugin n’altèrent pas l’immuabilité des sessions statiques.
```

## Opérations

### V-1 : Connect

```text
C⟦connect⟧ : () → ConnectionState

Effets:
  - GET /api/app-version
  - GET /api/version
  - met à jour l’état interne de connexion
```

### V-2 : Edit Static Session In VSCode

```text
E⟦edit_static⟧ : (sha1: SHA1) → { liveSha1: LiveId, hostPath: String? }

Effets:
  - POST /api/:sha/edit
  - si hostPath disponible: ouvre le fichier dans VSCode
  - POST /api/state { sha1: liveSha1 }
```

### V-3 : Sync Active DSP

```text
S⟦sync_active_dsp⟧ : (filePath: String) → { liveSha1: LiveId }

Précondition:
  - filePath termine par ".dsp"

Effets:
  - POST /api/live/open { filePath }
  - POST /api/state { sha1: liveSha1 }
```

### V-4 : Run Controls

```text
R⟦run⟧ : ("start" | "stop" | "toggle") → Unit

Effets:
  - POST /api/state { view: "run" } (optionnel)
  - POST /api/run/transport { action }
```

## API consommée par le plugin

- `GET /api/app-version`
- `GET /api/version`
- `POST /api/live/open`
- `POST /api/:sha/edit` (cf. `SPECIFICATION-EDIT-MODE.md`)
- `GET /api/sessions`
- `GET /api/state`
- `POST /api/state`
- `POST /api/run/transport`
- `POST /api/:sha/refresh`

## Commandes VSCode proposées

- `faustforge.connect`
- `faustforge.openWebUi`
- `faustforge.syncActiveDsp`
- `faustforge.editCurrentStaticSession`
- `faustforge.refreshCurrentSession`
- `faustforge.runStart`
- `faustforge.runStop`
- `faustforge.runToggle`

## UX minimale

1. Status bar:
   - `Faustforge: Connected` / `Disconnected`.
2. Notifications:
   - erreurs réseau,
   - session live créée/activée,
   - refresh OK/KO.
3. Output channel dédié:
   - logs techniques (HTTP status, erreurs).

## Sécurité

1. Aucune exécution shell arbitraire.
2. Validation stricte des URLs/config.
3. Timeout réseau borné.
4. Pas de collecte de données externe par défaut.

## Roadmap

### Phase 1 (MVP)
- commandes essentielles + sync session/vue.

### Phase 2
- panneau latéral faustforge (session, vue, run).

### Phase 3
- sync temps réel fine (SSE/WebSocket),
- assistants contextuels DSP (intégration MCP).
