# Specification: `faust-core-ui`

## 1) Purpose

`faust-core-ui` defines the minimal base class for Faust UI components.

Goals:

- explicit inheritance model
- minimal API surface
- no optional/generalized abstractions unless required

## 2) Types

```ts
type Path = string;
type ParamValue = number;
```

## 3) Base class

```ts
abstract class FaustUICore<TState> {
  protected readonly root: HTMLElement;
  protected readonly paramChangeByUI: (path: Path, value: ParamValue) => void;

  constructor(
    root: HTMLElement,
    paramChangeByUI: (path: Path, value: ParamValue) => void
  );

  // Host -> UI sync
  abstract setParamValue(path: Path, value: ParamValue): void;
  abstract setParams(values: Record<Path, ParamValue>): void;

  // State
  abstract getState(): TState;
  abstract setState(state: TState): void;

  // Layout
  abstract resize(): void;

  // Atomic updates
  beginUpdate(): void;
  endUpdate(): void;
  transaction(fn: () => void): void;

  // Lifecycle
  destroy(): void;
}
```

## 4) Data flow

- UI -> host: UI invokes the host callback `paramChangeByUI(path, value)` on effective user-driven parameter change.
- host -> UI: host calls `setParamValue` / `setParams` for external updates.

## 5) Atomic update semantics

- `beginUpdate()` starts (or nests) an atomic update section.
- `endUpdate()` ends one section; when depth reaches 0, a single visual/state flush is performed.
- `transaction(fn)` is equivalent to `beginUpdate(); try { fn(); } finally { endUpdate(); }`.

## 6) Errors

- missing `root` => throw in constructor
- missing `paramChangeByUI` => throw in constructor
- invalid state passed to `setState` => ignore and warn (`console.warn` by default)
