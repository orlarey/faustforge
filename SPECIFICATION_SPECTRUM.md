# Spécification : Spectre compact pour client IA

## Objectif

Remplacer l'envoi FFT brut (`spectrum.data`) par une représentation compacte, stable et directement exploitable par une IA dans une boucle:
1. modifier le DSP / les paramètres
2. mesurer
3. comparer
4. décider

## Principes de design

- **Compact** : limiter fortement le volume de données transmis.
- **Actionnable** : fournir des signaux faciles à interpréter (équilibre tonal, pics, métriques globales).
- **Stable** : garder un schéma JSON déterministe et versionné.
- **Comparatif** : inclure des deltas pour guider l'itération.

## Format cible

Type MCP/HTTP recommandé: `spectrum_summary_v1`

```json
{
  "type": "spectrum_summary_v1",
  "capturedAt": 1738900000000,
  "frame": {
    "sampleRate": 44100,
    "fftSize": 2048,
    "fmin": 20,
    "fmax": 20000,
    "floorDb": -110,
    "bandsCount": 32
  },
  "bandsDbQ": [-72, -68, -63, -59, -55, -50, -48, -45, -42, -39, -37, -36, -34, -33, -31, -30, -29, -30, -32, -35, -38, -41, -44, -47, -50, -53, -56, -59, -62, -66, -70, -74],
  "peaks": [
    { "hz": 110.0, "dbQ": -18, "q": 12.4 },
    { "hz": 220.0, "dbQ": -24, "q": 10.8 },
    { "hz": 330.0, "dbQ": -29, "q": 9.1 }
  ],
  "features": {
    "rmsDbQ": -14,
    "centroidHz": 1850,
    "rolloff95Hz": 6200,
    "flatnessQ": 12,
    "crestDbQ": 11
  },
  "audioQuality": {
    "peakDbFSQ": -1,
    "clipSampleCount": 24,
    "clipRatioQ": 3,
    "dcOffsetQ": 2,
    "clickCount": 5,
    "clickScoreQ": 18
  },
  "delta": {
    "rmsDbQ": -2,
    "centroidHz": 210,
    "rolloff95Hz": 480,
    "flatnessQ": -3,
    "crestDbQ": 1
  }
}
```

## Contrats MCP

### `get_spectrum`

- Retourne le dernier `spectrum_summary_v1` disponible.
- Source: `state.spectrumSummary` (prioritaire).
- Fallback de transition: `state.spectrum` (legacy) si `spectrumSummary` absent.

Exemple de payload:

```json
{
  "mime": "application/json",
  "content": {
    "type": "spectrum_summary_v1",
    "capturedAt": 1738900000000,
    "frame": { "sampleRate": 44100, "fftSize": 2048, "fmin": 20, "fmax": 20000, "floorDb": -110, "bandsCount": 32 },
    "bandsDbQ": [-72, -68, -63],
    "peaks": [{ "hz": 110, "dbQ": -18, "q": 12.4 }],
    "features": { "rmsDbQ": -14, "centroidHz": 1850, "rolloff95Hz": 6200, "flatnessQ": 12, "crestDbQ": 11 },
    "audioQuality": { "peakDbFSQ": -1, "clipSampleCount": 24, "clipRatioQ": 3, "dcOffsetQ": 2, "clickCount": 5, "clickScoreQ": 18 },
    "delta": { "rmsDbQ": -2, "centroidHz": 210, "rolloff95Hz": 480, "flatnessQ": -3, "crestDbQ": 1 }
  }
}
```

### `get_audio_snapshot` (compatibilité)

- Outil de compatibilité pour certains clients IA.
- Retourne le même contenu spectral que `get_spectrum`.
- L’export audio brut (`wav`/`pcm`) n’est pas implémenté dans cette version.
- Les arguments éventuels (`duration_ms`, `format`) sont acceptés mais informatifs.

### `trigger_button_and_get_spectrum`

Objectif: déclencher un bouton Faust puis retourner une série temporelle compacte pour analyse IA de l'évolution.

Entrée:

```json
{
  "path": "/instrument/excite",
  "holdMs": 80,
  "captureMs": 600,
  "sampleEveryMs": 80,
  "maxFrames": 10
}
```

- `path`: chemin du bouton (obligatoire).
- `holdMs`: durée de pression (défaut: `80`, plage `1..5000`).
- `captureMs`: fenêtre totale d'observation (défaut: `300`, plage `50..10000`).
- `sampleEveryMs`: période d'échantillonnage des résumés (défaut: `80`, min `40`, max `500`).
- `maxFrames`: limite de frames retournées (défaut: `10`, max `20`).

Sortie:

```json
{
  "path": "/instrument/excite",
  "holdMs": 80,
  "captureMs": 600,
  "sampleEveryMs": 80,
  "series": [
    {
      "tMs": 0,
      "summary": { "type": "spectrum_summary_v1", "capturedAt": 1738900000000 }
    },
    {
      "tMs": 80,
      "summary": { "type": "spectrum_summary_v1", "capturedAt": 1738900000080 }
    }
  ],
  "aggregate": {
    "mode": "max_hold",
    "summary": { "type": "spectrum_summary_v1", "capturedAt": 1738900000600 }
  }
}
```

Règles:

- `series` contient des snapshots ordonnés par `tMs` croissant.
- `tMs=0` correspond au moment du trigger.
- `aggregate.mode="max_hold"` est calculé sur toute la fenêtre `captureMs`.
- Si aucune frame n'est capturée: erreur explicite (`Run view active + audio running`).
- Les snapshots de la série suivent le même schéma `spectrum_summary_v1`.

### `set_run_param_and_get_spectrum`

Objectif: modifier un paramètre continu puis mesurer l'impact spectral avec une capture atomique.

Entrée:

```json
{
  "path": "/instrument/cutoff",
  "value": 2400,
  "settleMs": 120,
  "captureMs": 500,
  "sampleEveryMs": 80,
  "maxFrames": 10
}
```

- `path`: chemin du paramètre continu (obligatoire).
- `value`: nouvelle valeur du paramètre (obligatoire).
- `settleMs`: délai après écriture avant capture (défaut: `120`, plage `0..5000`).
- `captureMs`: fenêtre totale d'observation (défaut: `300`, plage `50..10000`).
- `sampleEveryMs`: période d'échantillonnage des résumés (défaut: `80`, min `40`, max `500`).
- `maxFrames`: limite de frames retournées (défaut: `10`, max `20`).

Sortie:

```json
{
  "path": "/instrument/cutoff",
  "value": 2400,
  "settleMs": 120,
  "captureMs": 500,
  "sampleEveryMs": 80,
  "series": [
    {
      "tMs": 0,
      "summary": { "type": "spectrum_summary_v1", "capturedAt": 1738900000000 }
    }
  ],
  "aggregate": {
    "mode": "max_hold",
    "summary": { "type": "spectrum_summary_v1", "capturedAt": 1738900000500 }
  }
}
```

Règles:

- force la vue `run` et démarre l'audio si nécessaire.
- applique d'abord `set_run_param(path, value)`.
- attend `settleMs`, puis lance la capture.
- `series` contient des snapshots ordonnés par `tMs` croissant.
- `aggregate.mode="max_hold"` est calculé sur toute la fenêtre `captureMs`.

## Champs

- `type`: version de format (`spectrum_summary_v1`).
- `capturedAt`: timestamp Unix en millisecondes.
- `frame`: métadonnées de capture.
- `bandsDbQ`: énergie par bande log-spacée, quantifiée en dB (entiers).
- `peaks`: `K` pics dominants (fréquence, niveau quantifié, facteur de qualité).
- `features`: descripteurs globaux robustes.
- `audioQuality` (optionnel): indicateurs temporels de qualité audio (saturation/clicks).
- `delta`: variation vs dernier snapshot publié.

## Extension qualité audio (clicks + saturation)

Le bloc `audioQuality` est optionnel dans `spectrum_summary_v1` (extension backward-compatible).

```json
{
  "audioQuality": {
    "peakDbFSQ": -1,
    "clipSampleCount": 24,
    "clipRatioQ": 3,
    "dcOffsetQ": 2,
    "clickCount": 5,
    "clickScoreQ": 18
  }
}
```

Définitions:

- `peakDbFSQ`:
  - pic temporel de la fenêtre en dBFS quantifié (pas 1 dB, `0` = plein échelle).
- `clipSampleCount`:
  - nombre d’échantillons au-dessus d’un seuil d’écrêtage (`abs(x) >= 0.999` recommandé).
- `clipRatioQ`:
  - proportion de samples écrêtés en pour-mille (`round(1000 * clipSampleCount / N)`).
- `dcOffsetQ`:
  - offset DC absolu quantifié (`round(abs(mean(x)) * 1000)`).
- `clickCount`:
  - nombre d’événements impulsionnels détectés sur la fenêtre.
- `clickScoreQ`:
  - score global de risque de click (0..100 recommandé).

### Heuristique de click (recommandée)

- Calculer la dérivée absolue `d[n] = abs(x[n] - x[n-1])`.
- Définir un seuil élevé (ex: `d[n] > 0.35`) + condition d’isolement local.
- Compter les impulsions courtes comme `clickCount`.
- Dériver `clickScoreQ` (normalisation sur la taille de fenêtre, bornée à `[0..100]`).

But:
- permettre à l’IA de détecter objectivement des défauts temporels audibles
  même quand le spectre moyen semble acceptable.

## Quantification et compression

- dB: quantification entière (`dbQ`) avec pas 1 dB.
- `flatnessQ`: `round(flatness * 100)`, plage `[0..100]`.
- fréquences: Hz en entier (ou float 0.1 Hz si besoin).
- `bandsCount`: recommandé `24` ou `32` (défaut: `32`).
- `peaks`: recommandé `K=8` (défaut), max `16`.

## Méthodes de calcul

### Bandes log

- Découper `[fmin, fmax]` en `N` bandes logarithmiques.
- Pour chaque bande: prendre l'énergie max ou moyenne en dB.
- Recommandation: `max-hold` sur fenêtre courte pour robustesse perçue.

### Pics

- Détection de maxima locaux sur spectre lissé.
- Trier par amplitude décroissante.
- Garder top-`K`.
- `q` approximatif = `f0 / bandwidth(-3 dB)`.

### Features

- `rmsDb`: niveau global.
- `centroidHz`: centre de masse spectral.
- `rolloff95Hz`: fréquence contenant 95% de l'énergie.
- `flatness`: rapport géométrique/arithmetic mean.
- `crestDb`: `peak - rms`.

## Politique d'émission

Pour limiter le trafic:

- cadence max recommandée: `5 Hz` (200 ms).
- émettre seulement si changement significatif:
- `|delta.rmsDbQ| >= 1` ou
- `|delta.centroidHz| >= 80` ou
- distance L1 normalisée des bandes > seuil (ex: `0.06`).
- sinon, ignorer la frame.

Pour `trigger_button_and_get_spectrum` (capture forcée):

- la capture force l'échantillonnage de la série pendant `captureMs`,
- mais garde la limite `maxFrames`,
- et publie `aggregate.max_hold` même si certaines frames intermédiaires sont manquantes.

## Compatibilité et migration

- Conserver temporairement le format historique (`spectrum.data`) derrière un flag.
- Nouveau champ recommandé dans l'état partagé:
- `spectrumSummary` (nouveau, snapshot courant)
- `spectrumSeries` (optionnel, buffer court pour capture tool)
- `spectrum` (legacy, optionnel de transition)
- MCP `get_spectrum` doit retourner `spectrumSummary` en priorité.

## Budgets cibles

- `bands=32`, `peaks=8`, features+delta:
- taille JSON typique: ~0.7 à 1.5 KB/frame (au lieu de plusieurs dizaines de KB).

## Contrat IA

L'IA doit pouvoir:

1. comparer deux snapshots sans FFT brut,
2. détecter les déplacements tonaux (`centroid`, `rolloff`, bandes),
3. détecter évolution harmonique (`peaks`),
4. prendre des décisions paramétriques directement exploitables.

## Versioning

- Incrémenter `type` pour toute rupture de schéma (`spectrum_summary_v2`, etc.).
- Garder les champs existants stables entre versions mineures.
