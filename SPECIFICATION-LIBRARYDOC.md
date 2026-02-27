# Spécification : Documentation des librairies Faust (MCP)

## Scénario de référence

Un assistant IA veut proposer ou expliquer des fonctions de la librairie Faust
sans charger toute la documentation en contexte.

Il interroge les outils MCP de documentation:
1. recherche textuelle de symboles pertinents,
2. inspection détaillée d’un symbole,
3. listing d’un module,
4. récupération d’exemples,
5. explication orientée objectif.

## Objectif

Définir le contrat des outils MCP réellement implémentés pour la documentation
Faust, avec un index précompilé embarqué dans l’image.

## Architecture

- Source documentaire: index JSON précompilé (`faust-doc-index.json`).
- Chargement: au démarrage/à la première requête, depuis un chemin connu côté image.
- Pas de fallback runtime vers scraping ou base SQLite.

## Outils MCP

### 1) `search_faust_lib`

```text
search_faust_lib(query: String, limit?: Int[1..100], module?: String)
  -> { query, module?, results: List<SymbolSummary> }
```

- Recherche textuelle (nom, nom qualifié, résumé, fichier source).
- `module` filtre un module/fichier `.lib` précis.

### 2) `get_faust_symbol`

```text
get_faust_symbol(symbol: String)
  -> { symbol: SymbolFull, alternatives: List<SymbolSummary> }
```

- Retourne l’entrée complète: résumé, usage/signature, paramètres, IO, snippet de test, source.
- Peut proposer des alternatives si la correspondance n’est pas strictement exacte.

### 3) `list_faust_module`

```text
list_faust_module(module: String, limit?: Int[1..500])
  -> { module, file, aliasHints, symbols: List<SymbolSummary> }
```

- Liste les symboles d’un module donné (ex: `filters`, `delays`).

### 4) `get_faust_examples`

```text
get_faust_examples(symbolOrModule: String, limit?: Int[1..50])
  -> { scope: "symbol" | "module", query, examples: List<Example> }
```

- Si `symbolOrModule` correspond à un symbole: exemples de ce symbole.
- Sinon, essai en mode module et extraction des snippets disponibles.

### 5) `explain_faust_symbol_for_goal`

```text
explain_faust_symbol_for_goal(symbol: String, goal: String)
  -> { symbol, goal, recommendation }
```

- Produit une explication orientée action pour un objectif DSP concret.

## Invariants

```text
INV-LIBDOC-1 : Les outils n’écrivent pas d’état serveur.
INV-LIBDOC-2 : Les réponses sont déterminées par l’index précompilé courant.
INV-LIBDOC-3 : Si l’index est absent, les outils renvoient une erreur explicite.
```

## Hors périmètre

- Recherche sémantique vectorielle.
- Analyse statique complète du code utilisateur.
- Templates génératifs prêts à l’emploi.
- Validation formelle de composition de types Faust.

Ces sujets peuvent faire l’objet d’une spécification future distincte.
