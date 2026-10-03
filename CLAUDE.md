# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this repository is

An ioBroker adapter of type `visualization-widgets` (`onlyWWW: true`, `mode: none`) that ships **no
Node.js runtime code**. It delivers one diagram in two places:

- a **vis-2 widget set** (`src-widgets/` → `widgets/flow/`), loaded by vis-2 through Vite module
  federation, declared in `io-package.json` under `common.visWidgets.flowWidgets`;
- a **ioBroker.devices plugin** (`src-dm-widgets/` → `admin/dm-widgets/`), loaded by the widget
  manager of ioBroker.devices, declared under `common.deviceWidgets`;
- an **admin tab** (`src-admin/` → `admin/tab.html` + `admin/tab-assets/`), declared as
  `common.adminTab`, where stored diagrams are edited without opening vis.

Both are thin. Everything that decides what a diagram *is* and how it looks lives in three shared
source packages that are compiled into both bundles:

| Package | Contents | Rule |
|---|---|---|
| `packages/core` | model, value resolution, geometry, runtime, SVG renderer | **No MUI, no socket, no icon package.** Only React. |
| `packages/editor` | the designer dialog | MUI + `@iobroker/gui-components`; host-agnostic via `EditorContext` |
| `packages/translations` | the dictionary | used by both bundles |

They are consumed through the aliases `@flow/core`, `@flow/editor`, `@flow/i18n`,
declared in each `vite.config.ts` (`resolve.alias`) and each `tsconfig.json` (`paths`). They are *not*
built or published separately — the bundles compile their TypeScript directly.

## Commands

```bash
npm install          # AT THE ROOT. This is a workspace; see "Why a workspace" below.
npm run build        # previews + both bundles
npm run build-vis    # only src-widgets -> widgets/flow/
npm run build-dm     # only src-dm-widgets -> admin/dm-widgets/
npm run build-admin  # only src-admin -> admin/tab.html + admin/tab-assets/
npm run dev          # src-preview on :3100 -- admin tab, widget and attribute editor with hot reload
npm run previews     # re-render the palette preview and the README pictures (light + dark) from the real renderer
npm run gallery      # render every template in both themes to tmp/gallery.html and look at it
npm run check        # tsc over packages/, tasks.ts, tools/, test/
npm run lint
npm test             # mocha: the core unit tests plus the ioBroker package checks
```

`npm run check` does **not** cover the bundles. Type check those with
`cd src-widgets && npx tsc --noEmit -p tsconfig.json` (same for `src-dm-widgets`, `src-admin` and
`src-preview`); they
have their own tsconfig because they need `@iobroker/types` globals and their own `paths`. `npm run
lint` does cover them: the project service resolves each file against its nearest `tsconfig.json`.

## The development preview

`src-preview/` is a dev server and nothing else: not built by `tasks.ts`, not in `files`. It imports the
admin tab's `DiagramManager` straight from `src-admin/src` and the shared packages through the usual
aliases, so it always shows the current sources.

- The admin address is one constant, `ADMIN_URL` in `src-preview/vite.config.ts` (env
  `IOBROKER_ADMIN` overrides it). It reaches the page through `define` (`__ADMIN_HOST__` etc., declared
  in `src/globals.d.ts`) and `index.html` through a `%ADMIN_ORIGIN%` placeholder, because the socket.io
  client must load before any module runs.
- It deliberately avoids port 3000. `@iobroker/socket-client` only guesses "admin is on 8081" on
  3000, and 3000 is where the vis-2 dev server usually runs; the preview passes the address
  explicitly instead and runs on 3100.

## Selection and the keyboard

`EditorSelection` has `node` for one and `nodes` for several (built with `selectNodes`, read with
`selectedNodeIds` in `packages/editor/src/selection.ts`); the inspector shows the single-node panel only
for `node`. In `Canvas.tsx` a press on the empty drawing starts a frame, Shift/Ctrl/⌘+click toggles a
node, and a plain press on one of several selected nodes moves them all -- it narrows the selection to
that node only on release without movement (`clickSelects`), since at the press it may still be a drag.
`moveNodes` shifts the waypoints of connections with both ends in the moved set.

Copy, paste and delete are in `useEditorShortcuts.ts`; the clipboard format is `clipboard.ts` in the
core (`iobroker.flow/nodes`, plain JSON text). Two constraints shaped it:

- **Focus decides.** Shortcuts act only while the focus is inside the designer's root element (or on
  the body / the dialog around it) and not in a text field. A press on the canvas focuses the SVG
  (`tabIndex -1`) for exactly this reason. vis-2 has its own Ctrl+C/V for widgets, but only when the
  focus is on `<body>`; the handler also stops propagation of what it handles.
- **Plain http.** ioBroker usually runs without TLS, where `navigator.clipboard` does not exist. Writing
  therefore goes through `execCommand('copy')` and a one-shot `copy` listener, reading through the
  browser's `paste` event. A module-level copy covers browsers that raise no `paste` event outside
  text fields; it is only used when the system clipboard did not receive the copy or no event came.

The shortcuts are disabled while a drag is in progress (`draft !== null`): a paste on top of a draft
would be overwritten by the next pointer move.

Arrow keys move the selected nodes by one grid step, Shift+arrow keys resize them around their centre
(`resizeNodes`; a circle has one size, so either direction changes its diameter). Every key press is
a commit with a `merge` key: presses with the same key within `MERGE_WINDOW_MS` replace the top of the
undo stack instead of pushing, so holding a key is one undo step. Undo, redo, save and any unkeyed
commit end the merge.

## Saving

`onSave` belongs to the host: the admin tab writes the state and stays open (`variant: 'inline'`),
the dialog of a widget hands the document back and closes. The **autosave switch** therefore only
exists inline -- a dialog that closed itself ten seconds after the last stroke would be a bug. It is
a `usePersistentState` preference (`flow.editor.autosave`, so it is of the browser, not of the
diagram; `flow.tab.selected` remembers which diagram was open the same way) and an effect with `config` in its dependencies: every change clears the pending timer and
starts a new one, which is what makes it a debounce rather than an interval (`AUTOSAVE_MS`). While the clock runs, the switch's symbol turns
(`flow-spin`, off under `prefers-reduced-motion`): the wait is then visible, and nobody wonders
whether anything is going to happen.

## Moving the middle of a line

An `orthogonal` route whose two ends leave in the same orientation has a middle segment (vertical
between two horizontal ends, horizontal between two vertical ones). `edgeGeometry` reports it as
`geometry.segment`, and the canvas puts a drag handle on it: a transparent line above the edge's own
hit area, below the node hit areas. Dragging stores `edge.bend`, the segment's position as a fraction
of the way from the start to the end (`bendAt`), so it keeps its place when a node moves; a double
click or the inspector's button removes it. No segment -- and no handle -- for curves, straight lines,
single-corner routes, waypoint routes, and routes whose ends are level (the segment would have length
zero).

While a connection is being drawn, `nodeAt()` is asked on every pointer move, not only on release:
the node it finds is drawn with a ring in the colour of the line and the rubber band snaps to its
middle, so it is visible *where the line would land* before letting go.

## Fill levels and "same as value"

`NodeRuntime.level` (0..100) is how full a node's body is drawn: the state of charge for a storage
node, otherwise the shown value's amount against `node.levelMax` (in the value's unit, before kW/MW
scaling). Three icons show the same level and the rest ignore it (`IconDefinition.level`: an
outline that replaces the `body`, plus the box inside it that fills from the bottom) -- the
**battery**, whose fixed bar would read as "almost empty" at 98 %, the **heat buffer**, whose two
heat lines give way to what is in it, and the **tank**, which is `cistern` without the wave and with
a scale on the inside of its right wall. The tank is the store of water *and* of gas
(`MEDIA.<medium>.icons.storage`) and what the cistern template places, because how full it is *is*
the number a tank is looked at for. Energy and heat keep their own symbol -- a battery is not a
vessel, and a buffer is recognised by its heat lines -- and show the level inside it instead. It stayed a *separate* icon rather than a change to `cistern`, so a
node that names that icon explicitly keeps the drawing it was given; only a node that names none
follows the medium. The clip path of the fill is named with `React.useId()`, never the node
id -- two widgets on one page share node ids, and a clip path is looked up document-wide.

`SrcSame` (`{ same: 'value', ...scaling }`) is a source that refers to the node's own value, as shown
(`resolveSrc`'s third argument). The charge level and the extra values offer it; on the value itself
and on connections it resolves to nothing, so there is no cycle to guard against.

## Rules, status texts, stale values, key figures, colour scales

All in step 3 of `computeRuntime`, with the pure parts in `packages/core/src/rules.ts`:

- **Order matters.** The colour scale (`node.colorScale`, green to red via `scaleColor`) is applied
  first, rules (`node.rules`, first match wins, `firstMatchingRule`) last -- they are the user's word
  over every automatism. A text node's rules compare its raw value; every other node's the number it
  shows. Numbers compare numerically, anything else only with `==` / `!=` as text (`rawText`).
- **Lines follow.** Edges are coloured in step 2, before node values exist; step 3c recolours every
  edge whose colour is inherited (`EdgeRuntime.inheritsColor`) from the final node colours.
- **Status texts** need the raw state value, which the `ValueGetter` (numbers only) does not carry:
  the hosts pass `raw` in the options (`useLiveStates`, and `efTimes[oid].raw` in both widgets).
- **Stale** compares the newest `ts` of the value's states with `now`. The hosts must keep `now`
  moving while anything can turn stale -- `needsClock(config)` says when -- or nothing ever gets old.
- **Key figures** (`node.kpi`) run after all nodes (step 3b): production is the sum of producers that
  no other producer feeds (MPPT strings and the box they feed must not count twice), grid and storage
  are signed as their nodes show them. See `autarky` / `selfConsumption`.
- `parseColorString` understands `hsl()` because the colour scale produces it; without that the tint
  and the muted line colour would fall back to opaque/grey.
- `.ef-blink` is paused with the rest of the animation and off under `prefers-reduced-motion`.

## Detail view, energy of today

The click action `chart` opens `HistoryDialog` (editor package, but imported **by path** from the
widgets, because the package index would pull the designer into their first chunk). It must not
import `@mui/icons-material`: vis-2 does not share it, and one icon costs ~70 kB of MUI internals in
the widget's sync chunk -- the close cross is drawn with the shared `SvgIcon`. `detailTarget` picks the
state (the action's own, else the value's) and the value's rescaling; `readDetail` reads it.

`node.energyToday` shows the energy of the day in the second line. With a `src` it is read from
there and nothing is integrated -- an inverter that counts the day itself is the number the user
compares with the manufacturer's app, and a reading beats an integral over a value that was only
sampled. A source counts in the unit its state object declares, **kWh when it declares none**, which
is what a "yield today" reports everywhere. Without a `src` the history adapter integrates the
node's value since local midnight (`aggregate: 'integral', integralUnit: 3600`, `loadEnergyToday`),
shown as Wh -> kWh; host readers spread the request options **after** their defaults, so `integral`
survives, and `energyRequests` skips the nodes that count for themselves.

## Picture export and the assistant

`exportImage.ts` clones the designer's `svg.ef-root`, drops what the renderer marks as editor-only
(`.ef-overlay`, `.ef-background`, `.ef-selection`), writes the page font and a background in, and
serialises it; PNG draws that onto a canvas at 2x.

The assistant (`DeviceWizard.tsx`, logic in `packages/core/src/assistant.ts`) scans all states,
keeps those with a power unit (the unit decides over the role -- `value.power.consumption` is used
for kWh meters too), guesses the kind from the **name first**, then the last part of the id, then the
path (`guessDevice` returns a confidence), and pre-ticks only confident guesses up to
`PRESELECT_LIMITS` per kind. `buildFromDevices` binds the states to the lines, not the nodes, and a
"house" consumption state becomes the house node's own value.

## History charts

`node.history` (`15m` ... `24h`) draws the recorded past of the value into the lower part of the body
(`packages/core/src/history.ts`). Only a value that is a plain state has one. The hosts read from the
installation's default history adapter (`system.config` -> `common.defaultHistory`) with
`getHistory(..., { aggregate: 'average', step: period / 60 })`; `loadHistory` caches per page and
decides what is stale (`historyRefreshMs`), the hosts just call it every 30--60 s. The devices card
reaches `getHistory` through the `socket` of its state context, which is `protected` in the typings
only -- without it the card draws no charts. The scale is anchored at zero only when the values come
near it (power), otherwise it is the values' own range (a voltage around 53 V would be a flat line).

## Last change / last update

`node.timestamp` (`lc` or `ts`) shows under the value when its state last changed or was last written;
for a formula the most recent of its states. The hosts keep `{ ts, lc }` per state next to the value
(`useLiveStates` in the editor, `efTimes` in both widgets) and pass them as `times` in the options of
`computeRuntime`, together with `now`. The text is `formatTimestamp` in `format.ts`: `Intl`
(`RelativeTimeFormat`, `toLocaleString`) writes it, so no dictionary entries are needed and every
language comes with its plural rules. A relative time has to advance without a state change, so the
hosts re-render every 30 s while a node shows one (`useClock`, `efClock`).

## What flows

`packages/core/src/media.ts`. The medium (`defaults.medium`: energy, water, gas, heat) is a table of
**presets, not behaviour** -- the renderer and the runtime never ask what flows, a line is a line and
a number is a number in the unit it was given. It supplies the unit of a new diagram, the reference
value for the dot speed, the icon a node kind gets when it names none (`defaultIcon(kind, config)`),
and the unit a counter of the day is read in when its object declares none (`counterUnit`: kWh for
energy, litres for water). Everything it sets is an ordinary field the user can overrule, and a
document without a medium behaves exactly like one of energy.

A store of water or gas is read as **how full it is**: `Medium.storageUnit` ('%') is used for a
`storage` node whose value names no unit of its own and whose state object declares none, before the
diagram's default. A battery is not -- its number is the power it takes or gives, and reading that as
a percentage would be wrong by three orders of magnitude, so energy and heat leave it unset. A
percentage prints without decimals everywhere (`defaultDecimals`), as the charge line always has.

It also decides what counts as **nothing flowing**: `DEFAULT_THRESHOLD` (1 W) is the energy case,
`Medium.threshold` the general one, and `edgeThreshold(edge, config)` converts it into the base unit
the runtime compares in. One watt of standby is noise; one cubic metre of gas an hour is a boiler at
full power, and a fixed 1 would draw every gas diagram dead.

Two things follow the unit rather than the medium, because the unit is what is actually true:

- **The time base of an amount** (`integralSeconds` in `format.ts`). `l/min` integrated over hours is
  sixty times too much, so `energyRequests` reads the unit of each node and hands the history adapter
  the right `integralUnit`; `amountUnit` names what comes out (`W` -> `Wh`, `l/min` -> `l`).
- **Whether the amount climbs into the next prefix.** Only energy does: 5000 Wh is 5 kWh, but nobody
  writes 5 kl where they mean five cubic metres.

The designer's wording comes from `mediumWord()` in `labels.ts` of the editor package, used by
`kindLabel()` and `kpiLabel()`: `kind_source_water` when the dictionary has it, `kind_source`
otherwise -- so only the words that really differ need an entry. "Autarky" is the rainwater share of
a water diagram for the same reason; the formula is the same, only the word is not.

The assistant reads the medium as well (`isFlowState(common, medium)`, `guessDevice(oid, name,
medium)`, `buildFromDevices(..., { medium })`): the units it accepts, the keywords it guesses from
and the icons it gives a consumer all come from `KEYWORDS`, `FLOW_UNITS` and `SINK_ICONS` per medium.
Only energy may be recognised without a unit -- `value.power` is the one role ioBroker has for this,
and a unitless number in a water installation is a number of anything.

The medium is **asked before a diagram exists**, not set afterwards: the admin tab's "new diagram"
dialog has it next to the name (`emptyConfig(medium)`, so the empty document already carries the unit
and the dot speed), and the template chooser opens on the medium of the diagram it was opened from
and shows only that medium's layouts plus the empty one. `mediumDefaults()` in `media.ts` is the one
place that says what picking a medium writes: `presets.ts`, `emptyConfig()` and the assistant all go
through it.

**One symbol per kind, everywhere.** `kindIcon()` in the editor draws the icon a node of that kind
really gets here (`defaultIcon(kind, config)`, or the node's own), and the palette, the inspector's
kind list, its from/to lists and the assistant all go through it. `KIND_ICONS` is only the fallback
for the kinds that draw no icon at all -- a junction, a caption, an image. That is why a palette
entry carries an icon only when it is *not* simply a kind (a valve, a pump): an override there would
show one symbol on the button and another in the list right next to it.

**What the designer offers to place** is `packages/core/src/palette.ts`, a list of entries per
medium rather than a list of kinds: a valve, a pump and a junction are all one `bus` -- a node that
something flows through -- and only the icon and the name tell them apart. An entry's `icon` is
written onto the node it creates (`''` means "deliberately none"), its `label` is an i18n key, and
without one the name is the kind's own in that medium (`paletteLabel` -> `kindLabel`). The energy
palette is deliberately the list it always was, one entry per kind and nothing overridden; a test
asserts exactly that, so adding a medium cannot silently change what an energy diagram offers.

The **inspector's type list is the same list**, not the raw kinds: `paletteEntryOf()` reads a node
back into the entry it was placed from (kind *and* icon, since three entries share `bus`), and
`paletteChange()` says what switching writes -- an entry's own symbol comes with it, the previous
entry's symbol goes with it, and an icon the user picked survives. Without this, a valve placed on
the left could never be turned into a pump on the right, and the two lists would disagree about what
exists.

Two more fields of an entry decide what a placed element **carries**:

- `reads` binds an empty state (`value: { oid: '' }`). A valve, a pump, a meter show their own
  reading; a bare junction shows what passes through it, so it has none. A `bus` **with an icon** is
  therefore a full node in the inspector as well -- the decoration rule asks for the icon, not for
  the kind.
- `onOff` are the i18n keys for true and false. The element is placed with `display: 'text'` and a
  text map for `true`/`1`/`false`/`0`, because the state behind a valve is a boolean far more often
  than a number and "1 l/min" is nonsense; it also gets the medium's `accent` as its colour and one
  rule that greys it at zero (`SWITCH_OFF_COLOR`), so an open valve is visibly open. A percentage
  valve needs nothing else: 0 is still off, and the number shows as it is.

**An extra value can be a switch too.** `NodeBadge.textMap` is the same map as the node's, looked up
with the raw state value, and the inspector offers the two words that matter (`insp_badge_true` /
`insp_badge_false`) rather than the node's list of pairs -- a badge is a boolean or a number, and
"1,00 l/min" under a node is nonsense for a valve. A value the map does not name still shows as a
number, so half a map is not a trap. `switchTextMap` / `switchText` / `withSwitchText` in
`palette.ts` are the one place that knows `true` and `1` are the same thing, used by the palette when
it places a valve, by the badge fields and by the node's own; they need `raw` in the options, which
every host already passes for the node status texts.

**The node's value has the same two fields**, right under its source, and they work on their own: a
word the map names **wins over the number whatever `display` says** (`word` in step 3). The flag was
a trap the other way round -- the user writes "offen" and "zu", nothing happens, because a second
field further down still says "number". `display: 'text'` now only decides what an *unmapped* value
does: a status string shows as it is, a number keeps its format. The four switch keys are edited in
those two fields and deliberately left out of the list of pairs below them, which is for everything
else a state may say.

**A connection has the same two fields**, right under its source (`FlowEdge.textMap`, `edgeWord` in
step 2). Only the label changes: the number still decides the direction, the threshold and how fast
the dots run, and a `split` edge is read from whichever of its two sources is currently showing. "No
value" it already had -- the `showValue` switch below the fields.

**`display: 'none'` is the third option**: the node shows no number at all, and the symbol moves into
the middle of the body instead of keeping the lower half free (`hasValue` in `FlowView`). The value is
still read -- rules, the fill level, the key figures and the worked-out flow all use it -- which is
what the hint under the field says. The select sits at the **top** of the value section, above the
source: it decides what the section is for, and it is what a user looks for when a node should be
just a symbol.

Every template names its medium in `PRESETS`, and `npm run gallery` binds demo values per medium
(`DEMO` in `tools/gallery.tsx`): 5200 is a house in watts and nonsense in cubic metres of gas. Both
rendering tools take their node labels from the real dictionary (`translations.de`), never from a
copy -- the copy fell behind the first time a template was added.

## Units

`packages/core/src/units.ts`. The unit a number is in comes from, in this order: the element's own
`unit`, the unit of its source's state object (`common.unit`, via `sourceUnit`), the diagram's
default. The same read also caches `common.max` (`cachedMax`, `sourceMax`), which is what a node
fills against when it has no `levelMax` of its own -- converted from the object's unit into the one
the value is shown in, since a meter in kW declares its maximum in kW. `levelMax: 0` is the way to
say "no fill" against a declaring object, so the field keeps a typed 0. The hosts read the objects (`loadUnits` with their `getObject`, cached per page) and pass
`cachedUnit` -- or the editor's `useObjectUnits` -- as `units` in the options of `computeRuntime`.

- A `factor` on a state source, or a formula with `*`, `/`, `^`, `%`, has no object unit: the object's
  unit no longer describes the number.
- **Edge values are converted to the base unit** (`unitScale`: kW -> W times 1000) before anything
  compares or adds them. `EdgeRuntime.value`/`magnitude` and a derived `NodeRuntime.value` are in the
  base unit, so the threshold, the dot speed (`refPower` is watts) and the sums of a node work across
  meters in W and kW. Display converts back (`value / factor`) and lets the auto-scaling pick the
  prefix. The edge `threshold` is therefore in the base unit too.
- A derived node shows the base unit its connections agree on (`commonEdgeUnit`); if they disagree,
  the diagram's default.

## Why a workspace

## Why a workspace

`npm install` must run at the root. `packages/core` and `packages/editor` are compiled *into* both
bundles, so they must resolve the same copy of React, MUI and `@iobroker/gui-components` as the bundle
around them. Without workspace hoisting, TypeScript sees two `@types/react` and rejects every
`ReactNode`, and at runtime a second React means a second context registry. If you ever see
`Two different types with this name exist, but they are unrelated`, a package got duplicated.

## Contracts with the two hosts

These were read out of the host sources; none of them is checked at build time, so breaking one shows
up only as a widget that does not appear.

### vis-2

- `common.visWidgets.flowWidgets.url` = `flow/customWidgets.js`, and `bundlerType` **must**
  be `"module"` for a Vite build (the opposite of the CRA template).
- Three lists must stay in sync: `exposes` in `src-widgets/vite.config.ts`,
  `common.visWidgets.*.components` in `io-package.json`, and the module file itself.
- `mf-manifest.json` is deliberately published: vis-2 reads it and refuses a widget set that does not
  share `react/jsx-runtime`. Never exclude it from the copy step.
- The shared list comes from `moduleFederationShared()` of `@iobroker/types-vis-2`. Do not hand-write it.
- vis-2 does **not** share `@iobroker/gui-components`, so it is bundled here. That is why
  `src-widgets/src/DiagramField.tsx` is behind `React.lazy` — see "Bundle size" below.

### ioBroker.devices

- Discovery is via the **instance objects**: the backend collects `common.deviceWidgets` from every
  `system.adapter.*` instance (`src/widget-utils/WidgetsManagement.ts` there). An instance must exist.
- `pluginLoader.ts` there loads `./translations` and then `./Components`, and picks the widget out of
  the **default export** of `./Components` by the name in `common.deviceWidgets.components[].name`.
- The settings dialog is a `jsonConfig` form. The designer reaches it as an item of `type: 'custom'`:
  - `url` must start with `./` to escape the adapter-relative default — `./adapter/flow/dm-widgets/customDevices.js`;
  - `name` is `<remote alias>/<exposed module>/<exported name>`, here `flow/Config/Designer`. The
    alias is `flow` on purpose, matching what `pluginLoader.ts` already registered;
  - the exposed module is read as `(await loadRemote(...)).default[<exported name>]` -- by the copy of
    `ConfigCustom` inside the device manager as well as by the current `@iobroker/json-config`. So
    `Config.tsx` **must** have a default export holding the components; with named exports only, the
    dialog shows "Component flow/Config/Designer not found ... Found:" and nothing else;
  - `guiApi: 2` declares React 19 / MUI 9. `@iobroker/json-config` also sniffs `mf-manifest.json` and
    refuses a bundle that shares `@iobroker/adapter-react-v5`.
- **The size field is the widget's, if it wants the big one.** The host prepends `size` with 1x1,
  2x1 and 2x1/2 only; `2x2` exists but its own widgets declare it themselves, so `getConfigSchema()`
  repeats the field with the fourth option. The host then dispatches `2x0.5` to `renderWide()`,
  `2x1` to `renderWideTall()` and `2x2` to **`renderHuge()`** -- a method `@iobroker/dm-widgets`
  2.0.1 does not declare yet, so it overrides nothing and has to be written out.
- **A tile is square, and the settings button is part of it.** `renderSettingsButton()` comes from
  the host as an element in the flow: a card that lets it follow the content is 145 x 167 in a grid
  of 145 x 145 tiles, and the button hangs below the frame. The card itself carries the
  `aspectRatio`, the content is absolutely positioned inside it, and the button is laid over the
  bottom edge.
- **The icon of the catalogue entry is resolved against `admin/dm-widgets/`**, not the adapter root:
  `common.deviceWidgets.components[].icon` must name a file that `tasks.ts` copies there.
- **The host does not share React through federation.** Its own bundle shares nothing at all; it
  publishes the instances it renders with on `window.__iobrokerShared__` (`react`, `react-dom`,
  `@mui/material`, `@mui/icons-material`, `@iobroker/gui-components`, `moment`), which is what
  `@iobroker/dm-widgets` means by "Host's React instance -- use this instead of importing 'react'".
  A plugin that just imports `react` gets whatever the shared scope holds, and with a second widget
  plugin on the page that is *its* bundled copy: the hooks then run against a React that is not
  rendering the tree and the widget dies with `Cannot read properties of null (reading 'useContext')`.
  `src-dm-widgets/hostShim.ts` therefore routes `react`, `react-dom`, the JSX runtime and
  `@mui/material` through a shim that prefers the host's instance. The federated module stays the
  fallback, because the same bundle's `./Config` is also loaded by an adapter's configuration page,
  where that global does not exist but the admin *does* register its React as a singleton.
- `getConfigSchema()` is typed against `@iobroker/dm-utils`, not `@iobroker/json-config` — the base
  class in `@iobroker/dm-widgets` uses that copy of the schema types, and the two are unrelated
  declarations to TypeScript.

### Any adapter's admin configuration

`src-dm-widgets/src/Config.tsx` is not devices-specific. An adapter's config page uses the same
`@iobroker/json-config`, so the same `type: 'custom'` item works there (the README has the snippet).
Two consequences for that file:

- **How a value is written back depends on `props.custom`**, exactly as `ConfigGeneric` of
  `@iobroker/json-config` does it: a per-object *custom settings* page takes `onChange(attr, value)`,
  every other form -- an adapter's configuration page and the device manager's widget settings --
  expects the whole `data` object back: `onChange({ ...data, [attr]: value })`. Handed only the
  attribute, those forms store nothing and merely light up the save button; a diagram chosen in the
  device manager fell back to "in this widget" and was gone after saving. The third argument is a
  callback for `oContext.forceUpdate([attr], data)`, without which this item keeps rendering the
  value it was mounted with.
- It **registers its own translations** at module load. The devices plugin loader does it beforehand,
  an adapter's config page does not, and without it the designer renders raw `flow_*` keys.
- The `url` must keep its leading `./`. `ConfigCustom` resolves a bare path against *the adapter being
  configured*; only `./` escapes to an absolute one.

## Working the flow out

`packages/core/src/hydraulics.ts`, switched on per diagram with `defaults.hydraulics`. A water
installation is not wired like an energy one: nobody meters every pipe, what exists is a valve that
is open or shut, a pump that runs, a tank that is full, and maybe one flow sensor. From those few
facts the lines follow.

- **Roles, not new kinds.** `defaultRole(node)` reads what a node already is -- the kind, and for the
  things that sit *in* a line its symbol (valve -> gate, pump -> driver, meter/flow sensor -> meter).
  `node.hydraulic` overrules it; the inspector offers that list only while the switch is on.
- **A shut element stops everything**, and a standing pump counts as shut -- that is what makes "pump
  off" a dark diagram. A node whose state nobody has written is taken as open: an unconfigured
  diagram should draw, not go dark.
- **A pump is the one element with a side.** It pushes the way it was drawn, which is what keeps it
  from feeding backwards into the tank that feeds it (`allowed()`).
- **One taker at a time** (`computeHydraulics`). A tank both gives and takes, so a search that asks
  "is this line between a giver and a taker" answers yes for the dead pipe out of a tank -- the taker
  at the other end being that tank itself. The ways are therefore searched per taker, with that taker
  struck from the givers.
- **The amount comes from a measurement**: a meter or flow sensor, else a consumer reading its own
  use, and only in the unit the diagram counts in. A pump never gives the amount -- it reports amperes
  or a percentage, which says "it runs", not "how much". Then the line flows *without* a number
  (`value === null`, `active === true`), which the renderer draws as a running line with no label.
- **A line with a reading of its own is never touched**, and a diagram without the switch behaves
  exactly as before.

**Ways, not shares.** `waysTo()` walks backwards from a taker over the pipes to everything that can
give -- never twice through one node, so no way runs in circles, capped by `MAX_WAYS` / `MAX_LENGTH`
because a mesh of rings has more ways through it than anybody wants to count. Each way gets a
`width`: the gates on it multiplied together, divided by its length, which is the only stand-in for
the resistance of a pipe. The taker's demand is then divided over its ways by that width, and every
line carries the **signed** sum of what runs through it. That one rule is all of it -- a chain, a
branch, a half-open valve, two tanks on one tap, and a ring.

**A ring needs no extra rule**, which is the point of doing it this way. Fed from one end, its two
halves are equally wide and carry half each. Fed from two, each giver's short way and the other's long
way use the pipe between them in *opposite* directions, the two shares cancel, and `|flow| < 1e-9`
leaves it idle -- the stagnation point, where a plumber would also put it.

**What a taker takes when it reads nothing** is how open the widest way to it is (`Way.gates`, the
openings only, no length). The length divides *one* taker's demand over *its* ways; it must not decide
how much that taker gets in the first place, or a flow sensor in one branch would lengthen that branch
and starve it. A gate only counts as partly open when it reads **percent** -- a boolean valve says open
or shut and nothing in between (`opening`). Two taps behind valves at 50 % and 100 % therefore get one
part against two. Physically a valve at half a turn does not pass half the water; as a share between
branches, that is what the picture means and the only reading the state supports.

**From shares to litres.** Where every taker that really takes reads its own use, the shares already
*are* the amounts (`exact && !guessed` -- a store that nothing can reach contributes neither). Failing
that, one meter or flow sensor sets the scale: it reads what runs through *it*, so the factor is its
reading divided by its own share and every other line follows. A sensor reading 3 in one of two equal
branches therefore means 6 in the trunk. With neither, the lines run without a number.

**A line the model left out carries zero**, not the placeholder (`still` in step 2 of the runtime).
Where the flow is worked out, a line missing from the result is *known* to be still, and the
placeholder would claim that nobody knows. That is what makes the meeting point of a ring readable --
it reads 0,00 l/min -- and the rule has to be the same for a whole plant whose pump stands, or one
dead pipe would answer differently from a dead installation. It says nothing about the lines that do
flow: those still show no number until something measures one.

Still not a simulation: no pressure, no head, no pipe diameters. It says what a person reading the
picture would say, and the tests are written as exactly those sentences. `npm run gallery` draws five
rings after the templates -- one house connection, the same with a valve at half a turn, two givers
with the dead pipe between them, and a tank with its pump running and standing -- because that is the
part no single assertion shows.

## What a caption says

`packages/core/src/template.ts`. The text of a `label` node may carry placeholders: `{{ val }}` is
the value of the state the caption is bound to (`node.value`), `{{ userdata.0.x.val }}` any other
one, `{{ ts }}`/`{{ lc }}` when that state was written or changed -- as "5 minutes ago", because that
is what a caption is for -- and `{{ ts_abs }}` the same as a date. A placeholder that reads nothing
becomes an empty string, so the text around it still reads.

- **The last segment decides**: `val`, `ts`, `lc`, `unit`, `ts_abs`, `lc_abs` are fields, anything
  else is a state id whose value is wanted (`{{ userdata.0.x }}`).
- **A placeholder may compute**, and then it is the expression language of `expr.ts` -- the same one
  the value sources use, so there is no second parser. Every reference is replaced by a generated
  variable and handed over as a number; one unknown state makes the whole expression null, as it does
  in a source. Whether a placeholder computes is decided by whitespace or one of `+*/%^()`, and
  deliberately *not* by a minus: `hm-rpc.0.x` is an id, `val - 1` is a subtraction.
- `templateOids()` is what `collectOids()` adds for a caption, so the hosts subscribe to what the
  text reads -- including every state named inside a calculation.
- Rendering happens in step 3 of `computeRuntime` (`NodeRuntime.text`), where the values, the times
  and the units already are; the renderer draws that, never the template.

## Fields that name an object

Every field that takes an object id (`ObjectIdField` in `SourceField.tsx`, used by `StateIdRow` and
`StateSourceRow`) shows the object's **symbol in front of the id and its name underneath**. The
symbol is searched the way the object browser searches it -- `Utils.findObjectIcon()` of
`@iobroker/gui-components` walks the state, then its channel, then its device -- and its path is made
relative to the page with the same `pageImagePrefix()` the object dialog needs. Both are cached per
page in a module-level map, because the same id is asked for by several fields and by every
re-render; `useObjectBadge` never writes state on the way in, only when a read comes back.

**Drawn with `Icon` of `@iobroker/gui-components`, not with an `img`.** It inlines a `data:image/svg`
through `react-inlinesvg`, so a single-colour symbol takes the colour of the text around it -- in an
`img` a black-drawn icon stays black and disappears on a dark theme. It also tells a single character
from a path, which is the other half of what `findObjectIcon` may return.

The **"choose" button** beside such a field is aligned to the top (`alignItems: 'flex-start'`) and
offset by the 16 px the label of a standard `TextField` takes, so it sits beside the input rather than
beside the object's name underneath it. The row needs `useFlexGap` for that: with its spacing as
margins, `Stack` resets every child's other margins to zero and the offset would be dropped.

## Where a diagram lives

`packages/core/src/storage.ts`. A widget attribute holds **either** a diagram (inline) **or** a
reference `{ "$ref": "flow.0.diagrams.<id>" }` to one stored in the adapter's namespace. The admin tab
only ever edits stored ones.

- **An object of type `config`, with the document in `native.flow`** (`diagramNative()`,
  `diagramFromNative()`). A diagram is a configuration, not a reading: a state would carry it as a
  string in its value and claim a timestamp, a quality and an acknowledgement for something that never
  changes by itself. The container `flow.<n>.diagrams` is a folder.
- **Both hosts follow it with `subscribeObject`** and read it once with `getObject` (`efWatchDiagram`
  in either widget), so an edit saved in the admin tab still reaches every open view the moment it is
  written. It is deliberately *not* part of the state subscriptions any more -- those are the readings,
  and only those.
- **Saving writes the whole object**, never `extendObject`: that merges `native` key by key, so a node
  or a setting the user removed would survive the save and come back on the next load.
- **`readDiagramAttribute()` must be asked before `normalizeConfig()`**, which turns a reference into an
  empty diagram without complaint (a reference has none of a diagram's keys).
- **References are only followed into `flow.<n>.diagrams.*`** (`isDiagramId`), so a widget cannot
  be pointed at an arbitrary object and have its `native` read; a stored diagram that is itself a
  reference is refused rather than followed.
- Renaming changes `common.name` only. The id is what every widget refers to.

The UI for choosing between the two is `DiagramAttribute` in the editor package, used by both hosts
(`src-widgets/src/DiagramField.tsx` and `src-dm-widgets/src/Config.tsx` are thin wrappers). The admin
tab is `src-admin/src/DiagramManager.tsx`, which runs the designer in its `inline` variant: fills the
page, stays open after saving, "discard" remounts it from the stored state. Everything that leaves the
current diagram goes through one `guard()` so unsaved changes are never thrown away silently.

Admin shows the tab of every instance with `common.adminTab`, running or not (the adapter never runs:
`onlyWWW`). It loads `adapter/flow/tab.html`; `patchHtmlFile` needs the socket loader's
`var script` to be the first statement of its `<script>`, so keep comments out of it in `index.html`.

## Bundle size

A shared federation module is bundled **as a whole namespace**; rolldown cannot tree-shake something it
has to hand over complete. Two decisions follow, and both have a measured reason:

- `src-dm-widgets/vite.config.ts` narrows `moduleFederationShared()` to a `SINGLETONS` list. Taking it
  as it came put 6.5 MB of fallback copies into `admin/dm-widgets/` — 4.3 MB of it `@mui/icons-material`
  for a dozen icons. Only things that genuinely break as a second copy stay shared.
- Because `@iobroker/gui-components` is therefore bundled, importing *anything* from its barrel in a
  module that the widget loads eagerly drags in all 620 kB of it. `FlowDm.tsx` gets `I18n` from
  `AdapterReact` in `@iobroker/dm-widgets` (the host's copy) instead, and `DiagramField.tsx` on the
  vis-2 side is lazy for the same reason.

Check after a change: `node -e` over `build/mf-manifest.json`, comparing `exposes[].assets.js.sync`
against `.async`. The vis-2 widget's sync set should stay around 100 kB.

## Design decisions worth not re-litigating

- **The document is a graph, not a drawing.** Edge routes are computed in `geometry.ts` on every
  render; nothing geometric is stored except optional `waypoints`. The predecessor
  (`iobroker.energiefluss-erweitert`) stores finished SVG paths, which is why moving a node there
  breaks every line that touches it.
- **A node with no source of its own derives its value from its connections** (`deriveNodeValue` in
  `runtime.ts`). That is why the classic four-node template needs three state ids and not seven. Which
  sum is the right one depends on the node kind, and the difference only appears once a node has flows
  in both directions: a `source` shows what leaves it (the net would be its conversion loss), a `sink`
  the net of what arrives, `grid`/`storage` the net as an outflow so the sign carries the meaning, a
  `bus` what passes through. The rule is derived twice in the tests for exactly this reason.
- **`icon: undefined` and `icon: ''` mean different things.** Undefined takes the icon of the node
  kind; an empty string means no icon, and the value then centres itself in the node. Collapsing the
  two would make it impossible to remove the icon a kind implies.
- **The icon goes beside the value in a wide box.** `iconPlacement`: from a width-to-height ratio of
  1.4 on (the default rounded box, 124 x 84, is one) the icon sits left and the text is centred in the
  room to its right; circles, squares and tall boxes keep it above. `node.iconPosition` overrides.
- **Label sizes are two settings, one of them relative.** `defaults.labelSize` is the diagram's
  (node labels and connection values; empty means three quarters of `fontSize`), `node.labelScale` a
  factor on it, shown as a percentage. Relative so that "all labels larger" stays one field. Use
  `pageLabelSize` / `nodeLabelSize`, never the numbers directly; `fitCanvas` reserves room below the
  nodes from them.
- **A number field keeps what is being typed** (`NumberField` in `fields.tsx`). While it has focus the
  text belongs to the input, not to the document: without that, "0." and "0," never exist, the
  document never sees a decimal separator and a tenth cannot be entered at all. Its arrows follow the
  number they start from -- tenths below two, whole units above -- because a threshold of 0.1 and a
  power of 3000 are both set with the same field. A field that **counts** something says `integer`:
  it steps in whole numbers and rounds what is typed, or "0.8 decimal places" is a thing a user can
  enter.
- **Decimal places follow the unit prefix, not the magnitude** (`defaultDecimals` in `format.ts`).
  Whole watts, two decimals once it is kilowatts — a magnitude rule prints "40,0 W" and "0,00 W", and
  no meter reads like that.
- **An edge with no colour takes the colour of wherever the energy comes from**, which flips with the
  direction. This is what makes a new connection readable without configuring anything.
- **The object browser has to be told where the adapter icons are.** `DialogSelectID` builds them as
  `${imagePrefix}/adapter/<name>/<icon>` and defaults that prefix to `.`, which is right only on a
  page served from the root. Our pages are deeper -- `/adapter/flow/tab.html`, the device
  manager, `/vis-2/edit.html` -- so every icon 404s as `/adapter/flow/adapter/...`.
  `pageImagePrefix()` in `SourceField.tsx` climbs as many levels as the page is deep (`../..` in the
  admin tab) and stays relative; an empty string is no use, the browser falls back to `.` for it.
  `EditorContext.imagePrefix` overrides it -- the development preview passes the admin's origin,
  because there the page comes from Vite and the icons from the admin.
- **A connection's value sits beside its line, or in a chip on it** (`defaults.edgeLabel`). Beside
  the line the distance is computed from the text's own width, so a label next to a vertical line
  clears it and the arrow on it; as a chip it goes on the middle of the line, because the rounded box
  brings its own background and needs no halo. The chip's outline takes the colour of an active line.
- **Edge labels show the magnitude, node values show the sign.** A minus next to an arrow reads wrong;
  a battery at −2.1 kW is charging, and that is information worth keeping.
- **The animation is CSS on a second dashed copy of each line**, not JavaScript. `--ef-shift` is one
  gap, so a cycle ends where it started. The host decides *whether* it runs (`animate`) because only
  the host knows about hidden tabs, off-screen widgets and `prefers-reduced-motion`; when it is off,
  an active edge draws a static arrow instead. **A line that flows without a number runs at the
  reference speed** (`dotDuration(null)`): the speed is proportional to the amount, and where nothing
  measures one there is none to derive -- but a worked-out line that is alive and stands still is
  exactly what the whole feature must not look like.
- **A style adjusts the host theme, it never replaces it** (`styles.ts`). `styledTheme()` runs first
  in `computeRuntime`, so the colour a node or a muted line is computed with is the one it is drawn
  with; the renderer asks the `DiagramStyle` for decisions (`cards`, `shadow`, `labelInside`, ...),
  never for its name. A new style is an entry there plus a `style_<id>` sentence. `npm run gallery`
  draws every style light and dark -- look at both before calling one done, a shadow that works on
  white can vanish on a dark surface.
- **`glass` is the one style whose bodies are see-through** (`glass`, `tube`, `lineScale`). The body
  is the surface colour at about half, with one gradient in the defs laid over every body for the
  highlight along its top edge -- which is why it carries `panel: true`: on a transparent widget there
  would be nothing behind the glass, and it would read as flat paint. Its lines are pipes: a faint
  casing under the line (`tube`, a factor on the width) and the width itself scaled (`lineScale`), the
  only thing a style says about a document value -- `edgeWidth(edge, config) * look.lineScale` in the
  runtime, so the user's own `lineWidth` still decides the proportions. It keeps `cards: false`: a
  valve and a pump are circles in every picture of an installation.
- **Glow is three filters, not one** (neon). The lines glow as *one* blurred copy of all active lines
  under them, in `userSpaceOnUse` over the canvas -- a straight line has a zero-height box, and a
  region relative to it would be empty; the copy holds no dots, so the running animation does not
  recompute it. Outlines use a wide halo, icons a narrow one: the wide one fills an icon in to a blob.
  Every filter region relative to a box is `-100%`/`300%`, because a card of 40 units cut off the
  3D shadow with a hard edge at `-40%`.
- **Separate renders need an `identifierPrefix`.** Filter and clip ids come from `React.useId()`,
  which is unique within one React root but restarts at zero in every `renderToStaticMarkup`. The
  gallery renders each card on its own, so it passes a prefix; without it every card draws the
  shadows of the first one.
- **Text fits its box by estimate, not by measurement** (`fitFontSize`). The renderer also runs in
  node for the previews and the gallery, where there is nothing to measure with; the character widths
  are measured once on system-ui, and a value never shrinks below half its size.
- **The core never reads a MUI theme.** Each host flattens its own into `FlowTheme` once
  (`themeFromMui`). The node accents deliberately do not come from the palette — photovoltaics must not
  turn blue because somebody picked a blue primary colour.
- **`expr.ts` is a hand-written parser, not `new Function`.** A widget configuration is data that
  travels through view exports; and the parser is what makes `null` propagate instead of producing
  `NaN kW`.

## Importing energiefluss-erweitert

`packages/core/src/importEnergiefluss.ts`. The one thing worth knowing before touching it: that format
has **no nodes**. A box is a `rect`, an `icon` and two `text` elements that merely overlap, with nothing
tying them together. The graph, however, is explicit in an unexpected place — a connection is stored
under the key `path_<a>_<b>`, where the two numbers are the element ids of the rectangles it runs
between. The importer therefore takes those rectangles as nodes and assigns every other element to the
box whose rectangle contains its centre, smallest box first.

Semantics taken from `main.js` of that adapter, not guessed:

- `elements[].source` is an **index into `datasources`**, not a state id; `-1` means unbound.
- The value is `source + sum(add) - sum(subtract)`, optionally `abs()` via `convert` — which is why
  anything beyond a bare state becomes a formula here.
- `calculate_kw`: `'auto'` is this widget's auto-scaling, `'calc'`/`true` divides by 1000 and prints
  kW, `'none'`/`false` **blanks the unit** over there (it really does), anything else keeps the
  configured unit. For `'auto'` and `'none'` the import leaves the unit unset, so the state object's
  unit shows; `'none'` keeps the raw number without scaling, and the `unit-blanked` warning says the
  unit now appears.
- An empty unit (`""`) counts as unset everywhere (`||`, not `??`): earlier imports wrote one, and it
  would otherwise hide the object's unit for good.
- `animation_properties` is only `positive` or `negative`; negative means the same reading flows the
  other way, which becomes `invert` on the source.
- Icons are matched by **keyword**, not by exact name (`ICON_PATTERNS`). The original lets the user
  pick from all of Iconify, so an exact lookup table misses most names. Order matters there:
  `electric-car` has to reach `car` before any electricity rule claims it.

`test/fixtures/energiefluss-default.json` is that adapter's own default layout, copied verbatim. It is
the document every user of it starts from, so it is the right regression input; `npm run gallery`
renders the conversion of it next to the templates.

## Files in and out

`packages/core/src/exchange.ts` reads every file and every pasted text, in both places that take one
(the designer's `< >` dialog and the admin tab's import), so a text that works in one works in the other.
`readImport()` tells three shapes apart: a **bundle** (`format: 'iobroker.flow/diagrams'`, what
"export all" writes), an **energiefluss-erweitert** configuration (checked before our own format: it
has none of our keys and would otherwise read as an empty diagram), and a **diagram**, which must at
least have a `nodes` array. Anything laxer accepts any JSON file as an empty diagram, which is how a
wrong file silently replaces a real one.

- A single-diagram file is **exactly what a widget stores** -- no name, no wrapper. The name comes from
  the file name (`nameFromFileName`), so the same file pastes into any designer.
- The core returns **codes** (`ImportErrorCode`, `ImportWarning.code` + `args`), never sentences for the
  user; `importErrorText()` and `ImportSummary` in the editor package translate them. Every warning
  code needs a `json_ef_warn_<code>` sentence in `en.json`, with one `%s` per arg -- a test reads the
  union from the source and checks both dictionaries.
- Import only ever **creates** diagrams, one after the other (`createDiagram` looks for a free id, and
  two parallel creations of "PV" would both pick `pv`).
- `downloadText` / `pickFiles` in `fileTransfer.ts` use throw-away elements; `pickFiles` resolves `[]`
  on `cancel` where the browser reports it and simply never settles where it does not.

## Unicode escapes in the sources

Keep backslash-u escapes as escapes. Twice now a tool on the way to the file decoded one into the
literal character: the object-view range end (U+9999) became a CJK ideograph in `storedDiagrams.ts`, and
the combining-mark range (U+0300 to U+036F) in `slugify` became two invisible characters. Both still
worked, which is exactly why they went unnoticed. If a script has to write an escape, build the
backslash with `chr(92)` and check the bytes afterwards.

## Tests

`test/core.test.ts` covers the pure parts, including the documents in `examples/` -- those are shipped
artifacts, so a test keeps them valid, unbound and free of icons that no longer exist.

It also covers the expression language, the unit scaling, the geometry, the direction/colour/derivation
logic in `runtime.ts`, and the document normalisation. Those are the places where a mistake is
invisible in a screenshot — a wrong sign or a unit off by a factor of 1000 looks perfectly fine until
somebody compares the diagram with their meter. Run `npm run gallery` for everything that is not:
it renders every template and every example in both themes into `tmp/gallery.html`.
