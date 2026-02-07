# Méthode de spécification formelle légère

Tout projet de développement logiciel commence par une spécification écrite en Markdown.

Cette spécification adopte une approche de **formalisation légère** : elle vise à exprimer
précisément le projet, ses concepts et ses contraintes, sans recourir à des outils de
preuve automatique ni à une syntaxe mathématique lourde.

La spécification est destinée en priorité à un lecteur compétent : le développeur du
projet et les IA utilisées comme outils de raisonnement, de conception ou
d’implémentation. Elle n’a pas vocation à être pédagogique ; les notions informatiques
générales sont considérées comme acquises et ne sont pas détaillées.

Les éléments formels (types, invariants, règles, transitions) sont exprimés de manière
compacte et systématiquement accompagnés d’une brève reformulation en langage naturel.
Cette redondance vise à faciliter la relecture, à réduire les ambiguïtés et à permettre
une vérification conceptuelle directe de la spécification.

La rédaction cherche un équilibre strict entre **clarté**, **précision** et **concision**.
La concision est essentielle afin de conserver une vision d’ensemble du système, de
limiter la charge cognitive et de permettre au lecteur — humain ou IA — de maintenir
l’intégralité du modèle en tête.

## Scénario de référence

Toute spécification commence obligatoirement par un scénario de référence.

Le scénario est une description narrative, non normative, du déroulement typique
du système considéré. Il introduit les acteurs, les objets et leurs rôles, sans
formalisation et sans anticipation sur l’implémentation.

Le scénario ne définit ni règles, ni invariants, ni comportements obligatoires.
Il sert uniquement de support conceptuel à la lecture de la spécification :
il nomme les entités avant qu’elles ne soient définies, et donne du sens aux
sections formelles qui suivent.

La spécification proprement dite commence après le scénario, par la définition
du vocabulaire du domaine.


## Format du document Markdown

La spécification est rédigée exclusivement en **Markdown standard** (y compris les lignes vides).
Elle doit rester lisible et exploitable dans un éditeur texte simple,
sans dépendance à un moteur de rendu particulier.

Aucun moteur LaTeX n’est requis ni utilisé.
En particulier, aucune notation LaTeX (formules inline, environnements mathématiques)
n’est autorisée dans le document.

Les notations mathématiques utilisent les caractères **UTF-8** lorsque nécessaire,
notamment :
`∀`, `∃`, `∈`, `⊆`, `≤`, `≥`, `≠`, `→`, `⇒`, `∧`, `∨`, `¬`.

Les ensembles, relations, prédicats et règles sont exprimés en **texte structuré**,
sans recours à un langage formel dédié.

Tout bloc formel **non exécutable** utilise par défaut le fence `text`.
Les blocs correspondant à un langage réel (par exemple `json`, `mermaid`, `ebnf`)
doivent explicitement indiquer ce langage.
Aucun bloc ne doit être laissé sans indication de langage.


## Caractérisation de l’approche

L’approche combine rigueur formelle et pragmatisme, en s’appuyant sur un ensemble
restreint de concepts issus des méthodes formelles, utilisés de manière lisible
et opérationnelle.

- **Types algébriques**  
  Les structures de données et les signatures des opérations sont définies de manière
  explicite à l’aide de types algébriques.

- **Termes**  
  Lorsque nécessaire, les données sont formalisées sous la forme de termes d’un langage
  abstrait défini dans la spécification. Ces termes servent de support aux règles
  sémantiques et aux transformations d’état.

- **Règles de réécriture**  
  Le comportement du système est décrit par des règles de réécriture sur les termes,
  plutôt que par du pseudo-code impératif. Ces règles expriment les transformations
  sémantiques induites par les opérations du système.

- **Logique du premier ordre**  
  Les invariants et contraintes globales sont exprimés à l’aide de la logique du premier
  ordre, en utilisant une notation textuelle et des symboles UTF-8.

- **Préconditions et postconditions**  
  Les opérations sont spécifiées de manière comportementale à l’aide de préconditions
  et de postconditions, dans l’esprit du *Design by Contract*.

Ce cadre formel vise à décrire **ce que le système est** et **comment il peut évoluer**,
tout en laissant volontairement ouvertes :

- l’implémentation,
- l’optimisation,
- la stratégie de calcul.

Ces choix sont considérés comme relevant de la phase d’implémentation et peuvent évoluer
sans remettre en cause la validité de la spécification.

## Notation

Les données et expressions sont représentées par des **termes** d'une syntaxe abstraite définie en notation BNF (`Terme ::= Constructeur(arg₁, ...) | ...`). Les opérations sont définies comme des **fonctions sémantiques** notées `F⟦.⟧ : A → B` où `F` est une lettre mnémonique (E pour évaluation, V pour validation, S pour stock, C pour création, T pour transition, etc.). Leur comportement est donné par des **règles d'inférence** de la forme :

```text
prémisse₁    prémisse₂
─────────────────────── [Nom]
     conclusion
```

Les contraintes globales sont exprimées en **logique du premier ordre** avec notation UTF-8 (`∀`, `∃`, `∈`, `⊆`, `∧`, `∨`, `¬`, `⇒`). Les ensembles en compréhension s'écrivent `{x ∈ X | P(x)}`, leur cardinalité `|E|`. Les modifications de structures utilisent `s{champ ← valeur}`. Tous les blocs formels utilisent un fence explicite (`text` pour les définitions non exécutables, `ebnf` pour les grammaires, etc.).

## Statut de la spécification

La spécification a un statut **normatif** pour le modèle de domaine, les invariants,
les règles de transformation et les comportements explicitement décrits.

Toute implémentation conforme doit respecter ces éléments.

Ce qui n’est pas spécifié est considéré comme volontairement laissé ouvert.
En particulier, la spécification ne contraint pas :

- les choix d’implémentation,
- les structures internes non observables,
- les stratégies d’optimisation ou de calcul.

La spécification peut évoluer au cours du projet. À un instant donné, elle constitue
la référence unique permettant d’évaluer la conformité conceptuelle du système.
