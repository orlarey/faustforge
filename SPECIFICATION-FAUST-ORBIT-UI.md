# Specification: `faust-orbit-ui`

## 1) Purpose

`faust-orbit-ui` is an Orbit-based Faust UI component built on `faust-core-ui`.

It specializes:
- state shape
- control construction from Faust JSON UI
- geometric interaction and distance mapping

## 2) Scenario

1. Host compiles/loads DSP.
2. Host gets Faust UI JSON via `.getUI()`.
3. Host creates `FaustOrbitUI(root, paramChangeByUI)`.
4. Host runs an atomic update:
   - `beginUpdate()`
   - `state = buildControls(ui)`
   - `setOrbitState(state)`
   - `endUpdate()`
5. User interacts; UI emits `paramChangeByUI(path, value)`.
6. Host forwards values to DSP.
7. External changes are pushed back via `setParamValue`/`setParams`.

## 3) Types

```ts
type Path = string;

type Point = { x: number; y: number };

type OrbitControl = {
  path: Path;
  label: string;
  min: number;
  max: number;
  step: number;
  color: string;
  x: number;
  y: number;
  enabled: boolean;
};

type OrbitState = {
  zoom: number;
  center: Point;
  innerRadius: number;
  outerRadius: number;
  controls: Record<Path, OrbitControl>;
};
```

## 4) Class

```ts
class FaustOrbitUI extends FaustUICore<OrbitState> {
  constructor(
    root: HTMLElement,
    paramChangeByUI: (path: Path, value: number) => void
  );

  // Host -> UI sync
  setParamValue(path: Path, value: number): void;
  setParams(values: Record<Path, number>): void;

  // Orbit-specific state
  getOrbitState(): OrbitState;
  setOrbitState(state: OrbitState): void;

  // Core aliases
  getState(): OrbitState;
  setState(state: OrbitState): void;

  // Build OrbitState from Faust UI JSON
  buildControls(ui: FaustUIItem[]): OrbitState;

  // Layout
  resize(): void;
  center(): void;

  // Lifecycle
  destroy(): void;
}
```

Inherited from `FaustUICore`:
- `beginUpdate(): void`
- `endUpdate(): void`
- `transaction(fn: () => void): void`

## 5) `buildControls(ui)` rules

`buildControls(ui)` returns a full `OrbitState` using current geometry context (`center`, radii, zoom):
- include all Faust parameter paths:
  - continuous: `hslider`, `vslider`, `nentry`
  - binary: `button`, `checkbox`
- for each path, set required `OrbitControl` fields:
  - `label` from Faust item
  - `step` from Faust item (`1` for binary controls)
  - `color` deterministic from path
  - `x`,`y` from default orbit layout
  - `enabled = true` by default

Invalid `ui` input: throw.

## 6) Interaction mapping

Gestures:
- drag control point -> update one control
- drag center -> update all enabled controls
- drag outer ring -> update all enabled controls
- shift+click control point -> toggle `enabled`

Local-drag authority rule:
- while a local drag is active (point/center/ring), control point positions are user-authoritative
- external host updates (`setParamValue` / `setParams`) may update values but must not reposition points until drag end

Value/position compatibility rule:
- on `setParamValue(path, value)`, the control point is repositioned only if the incoming value is not compatible with its current position
- if compatible, Orbit updates internal value state only and keeps point coordinates unchanged
- compatibility is type-dependent:
  - binary controls (`button`, `checkbox`): exact binary compatibility (`0|1`) from current distance-threshold mapping
  - continuous controls: compatibility within a tolerance (`step/2` when `step > 0`)

Distance mapping:
- `d <= innerRadius` -> `value = max`
- `d >= outerRadius` -> `value = min`
- else linear interpolation

Binary controls (`button`, `checkbox`):
- same distance model
- output quantized to `0|1` with midpoint threshold between inner and outer radii

## 7) State import rules

For `setOrbitState(state)`:
- unknown `controls[path]` ignored
- numeric fields clamped
- if `zoom` missing, keep current zoom (fallback `100`)
- if state is invalid, ignore and warn (`console.warn` by default)

## 8) Rendering invariants

- fixed zoom anchor: panel center
- at zoom < 100%, background/grid fills full visible panel
- pointer coordinate conversion includes zoom + render offsets
- transient invalid resize (`<2px`) ignored
- grid/background anchor is independent from current draggable center position
- dragging center must not move the grid/background anchor

`center()` behavior:
- recenter `state.center` to panel center
- relayout `controls[*].x/y` with initial layout algorithm
- reset `outerRadius` to default initialization value
- adjust `innerRadius` to remain valid

## 9) Styling

- CSS classes prefixed with `fo-`
- theme variables:
  - `--fo-bg`
  - `--fo-grid`
  - `--fo-center`
  - `--fo-ring`
  - `--fo-point`
  - `--fo-point-disabled`
- point color comes from `OrbitControl.color`
