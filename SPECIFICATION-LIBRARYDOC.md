# Spécification : Extension Documentation des Librairies Faust MCP

## Vue d'ensemble

Cette spécification propose des outils MCP pour accéder à la documentation des librairies Faust, facilitant le développement avec une approche fonctionnelle rigoureuse.

## Motivation

Actuellement, Faust MCP ne fournit aucune aide quant à l'utilisation des librairies Faust. L'utilisateur doit connaître les signatures, domaines et sémantiques des fonctions sans assistance. Cette extension vise à fournir une introspection complète et une documentation contextuelle.

## Outils proposés

### 1. Introspection des librairies

#### `list_libraries`
**Description** : Énumère toutes les librairies Faust disponibles  
**Paramètres** : Aucun  
**Retour** :
```json
{
  "libraries": [
    {"name": "stdfaust.lib", "description": "Librairie standard (importe toutes les autres)"},
    {"name": "oscillators.lib", "prefix": "os", "description": "Générateurs et oscillateurs"},
    {"name": "filters.lib", "prefix": "fi", "description": "Filtres analogiques et numériques"},
    {"name": "envelopes.lib", "prefix": "en", "description": "Générateurs d'enveloppes"},
    {"name": "effects.lib", "prefix": "ef", "description": "Effets audio"},
    {"name": "signals.lib", "prefix": "si", "description": "Traitement de signaux de base"},
    {"name": "basics.lib", "prefix": "ba", "description": "Primitives de base"},
    {"name": "maths.lib", "prefix": "ma", "description": "Fonctions mathématiques"},
    {"name": "delays.lib", "prefix": "de", "description": "Lignes à retard"},
    {"name": "reverbs.lib", "prefix": "dm", "description": "Réverbérations"},
    {"name": "routes.lib", "prefix": "ro", "description": "Routage de signaux"}
  ]
}
```

#### `list_functions`
**Description** : Liste les fonctions d'une librairie  
**Paramètres** :
- `library` (string) : Nom ou préfixe de la librairie (ex: "oscillators.lib" ou "os")

**Retour** :
```json
{
  "library": "oscillators.lib",
  "prefix": "os",
  "functions": [
    {
      "name": "osc",
      "signature": "freq → signal",
      "brief": "Oscillateur sinusoïdal"
    },
    {
      "name": "sawtooth",
      "signature": "freq → signal",
      "brief": "Oscillateur en dents de scie"
    },
    {
      "name": "square",
      "signature": "freq → signal",
      "brief": "Oscillateur carré"
    }
  ]
}
```

#### `get_function_signature`
**Description** : Retourne la signature formelle d'une fonction  
**Paramètres** :
- `library` (string) : Librairie
- `function` (string) : Nom de la fonction

**Retour** :
```json
{
  "function": "os.osc",
  "signature": "freq → signal",
  "type_annotation": "(ℝ⁺) → Signal",
  "arity": {"inputs": 1, "outputs": 1}
}
```

### 2. Documentation contextuelle

#### `get_function_doc`
**Description** : Documentation complète d'une fonction  
**Paramètres** :
- `library` (string) : Librairie
- `function` (string) : Nom de la fonction

**Retour** :
```json
{
  "function": "en.adsr",
  "signature": "(attack, decay, sustain, release, gate) → envelope",
  "type_annotation": "(Time, Time, Level, Time, Signal) → Signal",
  "parameters": [
    {
      "name": "attack",
      "type": "Time (s)",
      "domain": "ℝ⁺",
      "description": "Temps de montée de 0 à 1"
    },
    {
      "name": "decay",
      "type": "Time (s)",
      "domain": "ℝ⁺",
      "description": "Temps de décroissance de 1 à sustain"
    },
    {
      "name": "sustain",
      "type": "Level",
      "domain": "[0, 1]",
      "description": "Niveau de sustain"
    },
    {
      "name": "release",
      "type": "Time (s)",
      "domain": "ℝ⁺",
      "description": "Temps de relâchement"
    },
    {
      "name": "gate",
      "type": "Signal",
      "domain": "{0, 1}",
      "description": "Signal de déclenchement"
    }
  ],
  "description": "Génère une enveloppe ADSR (Attack-Decay-Sustain-Release) classique",
  "mathematical_definition": "env(t,g) = { t/tₐ si 0≤t<tₐ, 1-(1-S)(t-tₐ)/tᴅ si tₐ≤t<tₐ+tᴅ∧g=1, S si t≥tₐ+tᴅ∧g=1, S·exp(-(t-tᵣ)/tᵣ) si g=0 }",
  "rewrite_rules": [
    "en.adsr(a,d,s,r) : smooth ≡ en.adsr(a,d,s,r)"
  ],
  "examples": [
    {
      "code": "gate = button(\"gate\");\nfreq = 440;\nprocess = os.osc(freq) * en.adsr(0.01, 0.1, 0.7, 0.3, gate);",
      "description": "Oscillateur avec enveloppe ADSR simple"
    }
  ],
  "see_also": ["en.ar", "en.asr", "en.adshr"]
}
```

### 3. Recherche sémantique

#### `search_by_semantic`
**Description** : Recherche de fonctions par intention sémantique  
**Paramètres** :
- `query` (string) : Description en langage naturel

**Retour** :
```json
{
  "query": "filtre passe-bas résonnant",
  "results": [
    {
      "function": "fi.resonlp",
      "signature": "(fc, Q, gain) → filter",
      "relevance": 0.95,
      "brief": "Filtre passe-bas résonnant du second ordre"
    },
    {
      "function": "fi.lowpass",
      "signature": "(order, fc) → filter",
      "relevance": 0.72,
      "brief": "Filtre passe-bas Butterworth"
    }
  ]
}
```

#### `search_by_category`
**Description** : Recherche par catégorie fonctionnelle  
**Paramètres** :
- `category` (string) : Catégorie ("envelopes", "oscillators", "filters", "effects", "delays", "reverbs", "routing")

**Retour** :
```json
{
  "category": "envelopes",
  "functions": [
    {"name": "en.ar", "brief": "Enveloppe Attack-Release"},
    {"name": "en.adsr", "brief": "Enveloppe Attack-Decay-Sustain-Release"},
    {"name": "en.asr", "brief": "Enveloppe Attack-Sustain-Release"},
    {"name": "en.adshr", "brief": "Enveloppe ADSR avec hold"}
  ]
}
```

### 4. Analyse de dépendances

#### `analyze_code`
**Description** : Analyse le code pour identifier les fonctions utilisées  
**Paramètres** :
- `code` (string) : Code Faust à analyser

**Retour** :
```json
{
  "functions_used": [
    {
      "function": "os.osc",
      "library": "oscillators.lib",
      "defined": true
    },
    {
      "function": "en.adsr",
      "library": "envelopes.lib",
      "defined": true
    },
    {
      "function": "dm.zita_light",
      "library": "reverbs.lib",
      "defined": false,
      "suggestion": "import(\"reverbs.lib\") manquant"
    }
  ],
  "required_imports": ["stdfaust.lib"],
  "missing_imports": ["reverbs.lib"]
}
```

### 5. Exemples et templates

#### `get_examples`
**Description** : Exemples d'utilisation d'une fonction  
**Paramètres** :
- `function` (string) : Fonction complète (ex: "fi.resonlp")

**Retour** :
```json
{
  "function": "fi.resonlp",
  "examples": [
    {
      "title": "Filtre simple",
      "code": "import(\"stdfaust.lib\");\nfc = 1000;\nQ = 5;\nprocess = _ : fi.resonlp(fc, Q, 1);",
      "description": "Filtre passe-bas à 1kHz avec Q=5"
    },
    {
      "title": "Filtre contrôlable",
      "code": "import(\"stdfaust.lib\");\nfc = hslider(\"cutoff\", 1000, 20, 20000, 1);\nQ = hslider(\"Q\", 1, 0.5, 10, 0.1);\nprocess = _ : fi.resonlp(fc, Q, 1);",
      "description": "Filtre avec contrôles interactifs"
    }
  ]
}
```

#### `get_template`
**Description** : Templates de code prêts à l'emploi  
**Paramètres** :
- `category` (string) : Type de template ("synth_subtractive", "synth_fm", "delay_stereo", "reverb_simple", etc.)

**Retour** :
```json
{
  "template": "synth_subtractive",
  "title": "Synthétiseur soustractif basique",
  "code": "import(\"stdfaust.lib\");\n\nfreq = hslider(\"freq\", 440, 20, 5000, 0.1);\ngate = button(\"gate\");\ncutoff = hslider(\"cutoff\", 2000, 20, 20000, 1);\nres = hslider(\"resonance\", 1, 0.5, 10, 0.1);\n\nenv = en.adsr(0.01, 0.1, 0.7, 0.3, gate);\nosc = os.sawtooth(freq);\nfiltered = osc : fi.resonlp(cutoff, res, 1);\n\nprocess = filtered * env <: _, _;",
  "description": "Synthétiseur soustractif avec oscillateur en dents de scie, filtre résonnant et enveloppe ADSR",
  "parameters": ["freq", "gate", "cutoff", "resonance"]
}
```

### 6. Validation de types

#### `check_composition`
**Description** : Vérifie la compatibilité de composition de fonctions  
**Paramètres** :
- `f` (string) : Première fonction ou expression
- `g` (string) : Seconde fonction ou expression
- `operator` (string) : Opérateur de composition (":", ",", "<:", ":>", etc.)

**Retour** :
```json
{
  "composition": "os.osc : fi.resonlp(1000, 2, 1)",
  "valid": true,
  "f_outputs": 1,
  "g_inputs": 1,
  "result_signature": "freq → signal",
  "explanation": "Composition valide : os.osc produit 1 signal, fi.resonlp attend 1 signal en entrée"
}
```

Ou en cas d'erreur :
```json
{
  "composition": "os.osc, os.osc : fi.resonlp(1000, 2, 1)",
  "valid": false,
  "f_outputs": 2,
  "g_inputs": 1,
  "error": "Incompatibilité : 2 sorties → 1 entrée",
  "suggestion": "Utiliser ':>' pour mixer les signaux : (os.osc, os.osc) :> fi.resonlp(1000, 2, 1)"
}
```

## Format de réponse standardisé

Tous les outils retournent un JSON avec :
- Statut (`success`: boolean)
- Données (`data`: object)
- Erreurs éventuelles (`error`: string, optionnel)

```json
{
  "success": true,
  "data": { /* contenu spécifique */ },
  "error": null
}
```

## Cas d'usage

1. **Découverte** : `list_libraries()` → `list_functions("oscillators.lib")` → `get_function_doc("os", "osc")`
2. **Recherche** : `search_by_semantic("filtre qui résonne")` → `get_function_doc("fi", "resonlp")`
3. **Développement** : `get_template("synth_fm")` → modification → `analyze_code(code)` → correction imports
4. **Validation** : `check_composition("os.osc", "fi.lowpass(4, 1000)")` avant compilation

## Extensions futures possibles

- Visualisation graphique des signatures de type
- Générateur de diagrammes de flux basé sur le code
- Suggestions contextuelles basées sur l'historique
- Export de documentation personnalisée (PDF, HTML)
- Intégration avec un système de types dépendants pour vérification formelle

## Notes d'implémentation

- La documentation pourrait être extraite des commentaires `.lib` existants
- Base de données SQLite pour indexation et recherche rapide
- Cache local pour performances
- Possibilité de mise à jour via `update_library_docs()`
