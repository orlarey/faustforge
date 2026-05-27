# Alignement des spécifications avec AI-AUTHORING.md

Rapport produit le 2026-05-27 sur la branche `doc-alignment`,
mis à jour à l'issue de la Pass 2.

Référence d'écriture : [AI-AUTHORING.md](AI-AUTHORING.md) (convention markpage).

Cible de rendu retenue par l'auteur : **markpage** (<https://markpage.org>).
Toutes les recommandations Pass 2 ci-dessous ont donc été appliquées.

Périmètre audité : les 11 fichiers `SPECIFICATION*.md` (~3055 lignes).
Hors périmètre de cet audit : `README.md`, `ARCHITECTURE.md`, `FORMAL_METHOD.md`,
`DOCKERWEBTOOL.md`, `ANNONCE.md`, `FULLSPEC.md`.

---

## 1. Synthèse

Pass 1 : ✅ terminée — conformité atteinte sur les 11 fichiers.
Pass 2 : ✅ terminée — blocs spécialisés markpage appliqués par lots.

Commits produits sur la branche `doc-alignment` :

| Commit | Lot | Portée |
|---|---|---|
| `530a44c` | Préparation | Ajout d'AI-AUTHORING.md comme référence stable |
| `c69c9a3` | Pass 1 | SPECIFICATION.md : 19× nettoyage `\"...\"` parasites |
| `09e3ecb` | Pass 1 | SPECIFICATION-MCP-INTERACTIONS.md : 2× ajout lang hint `text` |
| `b8d9efb` | Rapport | Première version du rapport d'audit |
| `c47aedb` | Pass 2 — Lot 1 | ADT : SPECIFICATION + EDIT-MODE + RUN-PARAM-SYNC + VSCODE-PLUGIN |
| `eda7070` | Pass 2 — Lots 2+4 | inference (L1/L2) + algorithm (U1-U4, D1-D4, R-6) |
| `f8b4ff3` | Pass 2 — Lot 3 | mermaid flowchart à la place du diagramme ASCII (MCP-INTERACTIONS) |
| `100540a` | Pass 2 — bonus | definition list Pandoc pour les champs audioQuality (SPECTRUM) |

---

## 2. Pass 1 — Conformité

Trois fichiers touchés sur 11. Les huit autres étaient déjà conformes (pas de
LaTeX gratuit, pas de Mermaid avec flèches Unicode, pas de violation de
hiérarchie, pas de table dense en pipe au lieu de `csv`).

| Fichier | Correction |
|---|---|
| SPECIFICATION.md | 19× `\"...\"` → `"..."` dans les blocs fenced (artefacts de copier-coller JS/TS) |
| SPECIFICATION-MCP-INTERACTIONS.md | 2× ajout du lang hint `text` sur des fenced anonymes |

---

## 3. Pass 2 — Conversions appliquées

### 3.1. Lot 1 — ADT (`text` → `adt`)

Tous les `Foo ::= { … }` / `Foo = A | B | C` ont été convertis. Le bloc `adt`
de markpage offre la coloration des types (LHS d'une règle) et des constructeurs,
et impose une grille à quatre colonnes pour la mise en page.

| Fichier | Définitions converties |
|---|---|
| SPECIFICATION.md | Types primitifs (`SHA1`, `Code`, `Path`, `Bytes`, `View`) ; modèle de synchro (`ParamId`, `Value`, `Timestamp`, `UIId`, `ParamCell`, `DSPState`, `UIState`) ; `SessionMeta` ; `CppPreset` + extraction du sous-type `PresetStatus` pour éviter une ambiguïté de pipe dans un record |
| SPECIFICATION-EDIT-MODE.md | `SessionId`, `LiveId`, `PathContainer`, `PathHost`, `EditorKind`, `EditRequest`, `EditResponse` |
| SPECIFICATION-RUN-PARAM-SYNC.md | `Path`, `Value`, `Timestamp`, `RunParamCell`, `RunParamMap`, `Version` |
| SPECIFICATION-VSCODE-PLUGIN.md | `ForgeUrl`, `SessionId`, `LiveId`, `View`, `PluginConfig`, `ConnectionState` |

**Décision préservée :** le record `Session` (10 champs avec annotations
critiques par champ, dont la moitié sont des entrées de filesystem) est resté
en `text`. La grille 4-colonnes du `adt` renderer dégrade la lisibilité pour
ce cas précis, et ce n'est pas une vraie somme algébrique mais une
description de layout disque.

### 3.2. Lots 2+4 — Inference + Algorithm

Convertis en `inference` (vraies règles à prémisses) :

| Fichier | Règle | Forme |
|---|---|---|
| SPECIFICATION.md | L1 (acquire) | `acquire(p) by ui ; DSP.params[p].owner ∈ {⊥, ui} ⊢ DSP.params[p].owner := ui` |
| SPECIFICATION.md | L2 (release) | `release(p) by ui ; DSP.params[p].owner = ui ⊢ DSP.params[p].owner := ⊥` |

Convertis en `algorithm` (pseudocode séquentiel) :

| Fichier | Bloc | Notes |
|---|---|---|
| SPECIFICATION.md | U1-U4 (boucle synchro UI) | Caption "Cycle de synchronisation d'une UI u", `Input:`, `for each ... do ... end`, marqueurs `▷ U1`/`▷ U2`/… en commentaires inline |
| SPECIFICATION.md | D1-D4 (application update DSP) | Utilise `Require:` pour D1 (arbitrage lock) et D2 (fraîcheur), assignations en `:=` |
| SPECIFICATION-RUN-PARAM-SYNC.md | R-6 (réconciliation per-path) | Les **quatre blocs `text` séquentiels** ("Puis", "Enfin", "Cas d'égalité") sont fusionnés en un seul `algorithm` cohérent. La prose connective devient des commentaires `▷` inline |

**Décisions préservées (volontairement non converties)** :

- Opérations `O-1`..`O-9` dans SPECIFICATION.md
- `E⟦edit⟧` / `U⟦openEditor⟧` dans SPECIFICATION-EDIT-MODE.md
- `V-1`..`V-4` (`C⟦connect⟧` etc.) dans SPECIFICATION-VSCODE-PLUGIN.md

Ces opérations décrivent des **contrats fonctionnels** (signature, précondition,
postcondition) plutôt que des règles à prémisses. Le format `inference` est
conçu pour les jugements typés à la `Γ ⊢ e : T` : prémisses séparées par `;`,
ligne de tirets, conclusion. Forcer une signature de fonction dans ce moule
exigerait soit de décomposer chaque opération en plusieurs règles artificielles
(une par cas hit/miss), soit de détourner la conclusion vers une assignation
non-conventionnelle. Le `text` reste le bon véhicule pour ces contrats.

La typographie automatique de `inference` (`E⟦…⟧` → 𝓔⟦…⟧, lettres majuscules en
italique, etc.) ne s'active donc pas sur ces opérations. C'est un compromis
conscient : la lisibilité du contrat l'emporte sur la typographie.

### 3.3. Lot 3 — Mermaid

Le diagramme ASCII art `WRITE → SUBMIT → LISTEN → TWEAK → EVALUATE → (iterate)`
dans la section "4. Combined Workflow" de SPECIFICATION-MCP-INTERACTIONS.md est
remplacé par un `mermaid flowchart TD` à six nœuds avec flèches ASCII et arc
de retour `-.iterate.->`.

Le diagramme original (Unicode box-drawing) ne se mettait à l'échelle ni en
slides mode markpage ni dans les lecteurs reflowable, et l'arc d'itération
était caché dans la mise en page rigide. La version Mermaid auto-lay et reste
cohérente avec les deux blocs Mermaid existants de
[SPECIFICATION-RUN-PARAM-SYNC.md](SPECIFICATION-RUN-PARAM-SYNC.md).

### 3.4. Lot bonus — Definition list

Les six champs `audioQuality` dans SPECIFICATION_SPECTRUM.md étaient documentés
en deux-niveaux-de-puces (item top = nom du champ, puce imbriquée = glose).
Conversion en Pandoc definition list (`term` / `:   gloss`) — la sémantique
colle exactement à ce que la section fait.

---

## 4. Conversions non retenues (et pourquoi)

| Candidat audit initial | Statut | Raison |
|---|---|---|
| Session record (10 champs) → adt | Non | Grille 4-col mal adaptée à un layout filesystem avec annotations critiques par champ |
| Operations O-* / E⟦…⟧ / V⟦…⟧ → inference | Non | Contrats fonctionnels, pas règles à prémisses (voir §3.2) |
| Invariants INV-* → callouts `::: definition` | Non | Sur-marquage : les invariants vivent déjà bien en bloc `text` dans un § "Invariants" explicite |
| Signatures MCP de SPECIFICATION-LIBRARYDOC.md → algorithm | Non | Le `text` plat actuel est plus lisible que la mise en page algorithm pour de simples signatures |
| Distance mapping de SPECIFICATION-FAUST-ORBIT-UI.md | Non | Liste à puces existante claire ; pas de gain à passer en math display |

---

## 5. Points d'attention résiduels

- **Notation `S⟦…⟧` / `E⟦…⟧` / `V⟦…⟧` hors bloc inference** : ces opérateurs
  restent en `text` après Pass 2. La typographie automatique de markpage ne
  s'applique pas — ils s'affichent en mono-espacé. C'est le bon choix au vu de
  la nature des opérations (voir §3.2), mais à noter si une convention de
  publication exige plus tard une mise en forme typographique systématique.

- **`ALIGNMENT-REPORT.md` existant** (non versionné, daté 2026-02-27) parle
  d'un alignement *doc / implémentation* sur la v1.2.0. Ce rapport-ci est de
  nature différente (alignement *doc / convention d'écriture*). L'ancien
  rapport est probablement périmé (repo désormais en v1.7.1) — décision sur
  son sort à prendre séparément.

- **Hors-périmètre** : `README.md`, `ARCHITECTURE.md`, `FORMAL_METHOD.md`,
  `DOCKERWEBTOOL.md`, `ANNONCE.md`, `FULLSPEC.md` n'ont pas été audités. Si
  l'un d'eux entre dans le pipeline markpage, un audit similaire serait
  bénéfique.

- **Warnings markdownlint** (MD022, MD032, MD060) signalés par l'IDE sur
  plusieurs des fichiers touchés concernent l'espacement autour des listes et
  des en-têtes, et l'alignement des pipe tables. Ils sont **pré-existants** et
  hors zone d'edit ; non corrigés pour ne pas mélanger les concerns dans les
  commits Pass 2. À traiter dans une passe lint séparée si désiré.
