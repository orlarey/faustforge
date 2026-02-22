# Spécification : Mode édition pour sessions statiques

## Scénario de référence

Un utilisateur travaille sur une session **statique** (créée par drop/paste).  
Il souhaite modifier le code dans son éditeur local habituel (ex: VSCode).

Depuis l’interface faustforge, il clique sur le bouton **Edit**.

Le service:
1. copie le code de la session statique dans le workspace live partagé,
2. crée (ou réutilise) une session live liée à ce fichier,
3. retourne un lien d’ouverture éditeur côté hôte (`vscode://file/...`),
4. bascule l’UI sur la session live.

L’utilisateur édite et sauvegarde localement; la session live se met à jour via le mécanisme live existant.

## Objectif

Permettre une transition explicite **statique -> live éditable** en un clic, sans casser:
- l’immuabilité des sessions statiques,
- les invariants de session live,
- la séparation conteneur Docker / hôte.

## Vocabulaire du domaine

- **Session statique**: session immuable identifiée par `sha1(contenu)`.
- **Session live**: session mutable liée à un chemin local.
- **Workspace live**: dossier monté dans le conteneur, partagé avec l’hôte.
- **Open URL éditeur**: URI d’ouverture côté hôte (`vscode://file/...`).
- **Mapping host/container**: correspondance `LIVE_WORKSPACE_ROOT` (conteneur) vers `HOST_LIVE_WORKSPACE_ROOT` (hôte).

## Contraintes d’architecture

1. Le backend Node exécuté dans Docker ne lance pas directement une application GUI de l’hôte macOS.
2. L’ouverture de l’éditeur est demandée au navigateur via URI (`window.location = "vscode://..."`).
3. Le backend ne renvoie que des chemins/URI; il n’exécute pas `code`, `open`, ni AppleScript.

## Types

```text
SessionId      = SHA1 | LiveId
LiveId         = "live-" + SHA1
PathContainer  = String
PathHost       = String
EditorKind     = "vscode"

EditRequest ::= {
  editor?: EditorKind,          -- défaut: "vscode"
  openEditor?: Bool             -- défaut: true
}

EditResponse ::= {
  sourceSha1: SHA1,
  liveSha1: LiveId,
  filename: String,
  containerPath: PathContainer,
  hostPath?: PathHost,
  editorUrl?: String,
  openEditorRequested: Bool
}
```

## Variables d’environnement

```text
LIVE_WORKSPACE_ROOT      -- chemin workspace côté conteneur (ex: /workspace)
HOST_LIVE_WORKSPACE_ROOT -- chemin équivalent côté hôte (ex: /Users/me/faust-workspace)
```

Règle:

```text
containerPath = LIVE_WORKSPACE_ROOT + "/faustforge-edit/" + sourceSha1 + "-" + safeFilename
hostPath      = HOST_LIVE_WORKSPACE_ROOT + "/faustforge-edit/" + sourceSha1 + "-" + safeFilename
```

## Invariants

```text
INV-EDIT-1 : Le mode édition ne modifie jamais la session statique source.
INV-EDIT-2 : Toute édition passe par un fichier du workspace live partagé.
INV-EDIT-3 : Une session live créée par édition respecte INV-LIVE-1..3 de SPECIFICATION.md.
INV-EDIT-4 : Si HOST_LIVE_WORKSPACE_ROOT est absent, editorUrl n'est pas fourni.
INV-EDIT-5 : L'opération est idempotente pour (sourceSha1, targetPath) à contenu inchangé.
```

## Opérations

### O-EDIT-1 : Promote to editable live

```text
E⟦edit⟧ : (sourceSha1: SHA1 × req: EditRequest) → EditResponse

Préconditions:
  - sourceSha1 ∈ Sessions
  - Sessions[sourceSha1].kind = "static"
  - LIVE_WORKSPACE_ROOT configuré et accessible en écriture

Postconditions:
  1) code := content(Sessions[sourceSha1].user_code.dsp)
  2) targetFile := resolveEditablePath(sourceSha1, filename)
  3) write(targetFile, code)            -- création ou overwrite atomique
  4) live := createOrUpdateLiveSessionFromFile(targetFile)
  5) state.sha1 := live.sha1            -- bascule session active
  6) si mapping host disponible:
       hostPath := mapToHost(targetFile)
       editorUrl := "vscode://file/" + urlEncode(hostPath)
```

Erreurs:
- `404` si session source absente
- `409` si session source non statique
- `400` si workspace live non configuré
- `500` si erreur IO/mapping interne

### O-EDIT-2 : Open editor hint (frontend)

```text
U⟦openEditor⟧ : (editorUrl: String) → Unit

Précondition:
  - editorUrl non vide

Effet:
  - tentative d'ouverture via navigateur (navigation vers URI scheme)
  - en cas d'échec, affichage d'un fallback avec hostPath copiable
```

## API HTTP proposée

### `POST /api/:sha/edit`

Body:

```json
{
  "editor": "vscode",
  "openEditor": true
}
```

Response:

```json
{
  "sourceSha1": "<sha1 static>",
  "liveSha1": "live-<sha1>",
  "filename": "my.dsp",
  "containerPath": "/workspace/faustforge-edit/<sha1>-my.dsp",
  "hostPath": "/Users/me/faust-workspace/faustforge-edit/<sha1>-my.dsp",
  "editorUrl": "vscode://file//Users/me/faust-workspace/faustforge-edit/<sha1>-my.dsp",
  "openEditorRequested": true
}
```

## Règles UI

1. Le bouton **Edit** n’est visible que pour les sessions `kind=static`.
2. Au succès de `POST /api/:sha/edit`:
   - session courante = `liveSha1`,
   - badge `LIVE` visible,
   - si `openEditor=true` et `editorUrl` présent: tentative d’ouverture.
3. Si `editorUrl` absent:
   - afficher message: "Host mapping unavailable"
   - proposer copie de `containerPath` + aide de configuration.

## Sécurité / robustesse

1. Normaliser et valider `safeFilename` (pas de `..`, pas de `/`).
2. Ne jamais accepter de chemin arbitraire fourni par le client.
3. Créer le dossier parent avec permissions minimales.
4. Écriture atomique recommandée (`tmp` + rename).
5. Journaliser `sourceSha1`, `liveSha1`, `targetFile`.

## Notes de compatibilité macOS + VSCode

1. Le schéma `vscode://file/...` est résolu par macOS côté hôte, pas par Docker.
2. L’ouverture automatique dépend du navigateur et de l’enregistrement du handler VSCode.
3. En fallback, l’utilisateur peut ouvrir manuellement `hostPath` dans VSCode.
