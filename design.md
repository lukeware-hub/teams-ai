# Teams AI — design system

**Part I** — the system: durable, app-wide decisions every surface inherits.
**Part II** — the onboarding flow: six screens.
**Part III** — the app screens: shell, refinement, projects, run.

Specification, not implementation. It names values, roles and rules; it ships no CSS. Where document and code disagree, the document is the decision and the code is the defect.

## Visual authority

Three reference screens, supplied by the user, pin the target:

1. **`Tudo pronto para começar`** — the onboarding completion screen. Pins: soft dimensional surfaces, a violet-to-indigo gradient action, tinted card grounds, spot illustration, celebration used once.
2. **`Documentos do projeto / Área de revisão / Lista de verificação`** — the refinement screen. Pins: a breadcrumb bar, three equal panels, the tile + overline + title + chip header, tabs, a line-numbered editor, icon-led section headers, and **flat** primary actions.
3. **`aiworkspace.app/dashboard`** — a night AI workspace. Pins **the dark theme only** (§3.10): indigo-black ground with violet and blue ambient light, glass panels with lavender hairlines, a glowing violet primary, saturated gradient icon tiles, rounder geometry. Its layout and content belong to another product and are not copied.

Together they settle the question the first reference alone left open: **the app is not a quieter version of the onboarding.** Both are built to the same craft level, with the same tiles, chips, radii and rhythm. What the onboarding gets that the app does not is exactly three things — the gradient action, the illustration, and the celebration. Everything else is shared.

Hex values are sampled by eye from the screenshots and marked **≈** where they need confirming against source. Code measurements are from `web/src/styles.css` at `a60a961`.

---

# Part I — The system

## 1. Scope, mode and authority

**Applies to** every screen in `web/src`: `/onboarding`, `/projects`, `/runs/:runId`, `/refine/:projectId/:specId`, `/costs`, `/costs/:projectId`, `/chat`, `/settings`.

**Mode: Operate.** Every surface exists to let someone finish a task. Expression never outranks the task, the state, or the familiar affordance. The failure mode is not blandness, it is *strangeness without purpose* — over-decorated controls, mismatched form elements, gratuitous motion, invented affordances for standard jobs. The bar is **earned familiarity**: a category-fluent developer trusts the interface immediately and never pauses at a subtly-off control.

**The onboarding exception is narrow.** Onboarding is seen once and is the product's first impression, so it carries the gradient action, the illustration and one celebration. It does not carry a different type scale, a different radius family, or a different component vocabulary. A user who finishes setup and lands on `/projects` should feel they stayed in the same product.

**Authority order.** Token → primitive → surface. A surface composes; it never invents a color, size, shadow or radius. Three uses with one intent makes a token; two is duplication and stays local.

---

## 2. What the codebase contains today

| Measure | Count |
|---|---|
| Hex color literals | 139 |
| …of which unique | **92** |
| `rgba()` literals | 18 (16 unique) |
| `var(--…)` references | 95 — a minority against 157 literals |
| Distinct `font-size` values | **30** |
| Distinct `box-shadow` declarations | **14** of 15 |
| Distinct `border-radius` values | **15** |
| Selectors in one file | **209** |

Duplication, by family:

- **Nine** implementations of one pill chip: `.status-chip` `.status-pill` `.phase` `.test` `.badge` `.tag` `.doc-state` `.count-pill` `.status-dot`
- **Six** implementations of one message box: `.error` `.notice` `.warning` `.next-step` `.setup-complete` `.claude-session`
- **Seven** selectors drawing one tracked micro-label: `.eyebrow` `h3` `th` `.tokens-subhead` `.panels h5` `.conversation h4` `.panels h4`
- **Five** containers with near-identical border, radius and ground: `.card` `.panel-card` `.card-inner` `.patch` `.history`

Each family is specified **once** below, with tone as a variable it reads — never a re-declaration.

---

## 3. Color

### 3.1 Ground, rules, ink

| Role | Value | Use |
|---|---|---|
| `bg` | ≈`#f6f7fc` | Page |
| `surface` | `#ffffff` | Cards, panels |
| `surface-sunken` | ≈`#f8fafc` | Editor ground, empty-state boxes, read-only fields, row hover |
| `surface-muted` | ≈`#f1f4f8` | Neutral chip, inline code |
| `line` | ≈`#eef1f6` | Card borders, hairlines. Lighter than today's `#e4e8f0`; elevation carries the edge. |
| `line-strong` | ≈`#dde3ee` | Control borders the user must actually see |
| `ink` | `#182235` | Titles, values, control labels — 15.92:1 |
| `ink-soft` | `#5b6b84` | Descriptions, meta, section overlines, **placeholders** — 5.41:1 |
| `ink-faint` | `#8593a8` | **Non-text only** — idle dots, leading field icons, editor gutter, disabled glyphs — 3.12:1 |
| `ink-hover` | `#273657` | Dark-control hover |

Two ink levels carry text. A third "even quieter" gray is how the current file reached eight of them; the answer to quiet text is size and weight, not another gray. The editor's line-number gutter is the one place `ink-faint` renders characters, and it is exempt because those digits are a coordinate, not content.

### 3.2 Accent — one ramp, two uses

| Role | Value | Use |
|---|---|---|
| `accent` | `#4357c7` | **Every primary action in the app.** Links, active tab, focus ring, selected state. |
| `accent-2` | ≈`#7b4fef` | Ramp end. Never used alone. |
| `gradient-primary` | ≈`linear-gradient(115deg, #4a54e8 0%, #7b4fef 100%)` | **The onboarding flow only** — see §3.3 |
| `accent-hover` | `#3949ad` | Accent hover |
| `accent-text` | `#4357c7` | Accent **as text** — links, active tab, quiet actions. Equals `accent` in light; the dark theme splits them because a fill that carries white text is too dark to read as text (§3.10). |
| `on-accent` | `#ffffff` | Text on an `accent` fill |
| `accent-ink` | `#2f3f9e` | Accent text on `accent-soft` — 7.96:1 |
| `accent-soft` | ≈`#eef1fe` | Tinted ground: icon tiles, active tab, guidance callout, chips |
| `accent-soft-hover` | ≈`#e2e6fa` | Its hover |
| `accent-line` | ≈`#dfe4fb` | Border of an accent-tinted surface |

A second accent family exists for one job only — the violet icon tile in the refinement panel header:

| Role | Value | Use |
|---|---|---|
| `violet-soft` | ≈`#f0edfe` | Icon tile ground |
| `violet` | ≈`#6b5bd6` | Its glyph |

This is **not** a second accent. It never fills a control, never marks state, never appears in text. It exists so three adjacent panel tiles can be told apart at a glance — indigo, violet, green — which is the only reason a second hue is permitted anywhere in this system.

### 3.3 The gradient rule

`gradient-primary` is the look of **every primary action in the app** (decision of 2026-10-15, replacing the earlier rule that kept it to the onboarding flow). It also fills the onboarding progress bar and the product mark in the rail.

The primary button carries `gradient-primary` with `shadow-primary`, and `gradient-primary-hover` on hover. `accent` stays the flat color of links, focus, selection and the active tab.

Never on text, a card, a border, a chip, a heading, or an icon.

### 3.4 State

| Role | Base | Soft ground | Border | Text on soft |
|---|---|---|---|---|
| good | `#197044` | `#e7f7ee` | `#cce8da` | 5.50:1 |
| bad | `#b8272c` | `#fdeceb` | `#f5cfcd` | 5.46:1 |
| warn | `#7d5f00` | `#fff8db` | `#ecd98c` | 5.61:1 |
| info | — | `#ddf4ff` | — | — |

Display-only greens, which never carry text: `good-bright` ≈`#22c55e` (check glyph, confetti), `good-live` `#2f9e61` (pulsing session dot). `bad-ink` `#7a2426` for body text inside an unexpected-error block.

### 3.5 Tints and washes

Onboarding only.

| Role | Value | Use |
|---|---|---|
| `tint-good` | ≈`linear-gradient(160deg, #ffffff, #f1fbf5)` | The success card's ground |
| `wash-good` | ≈`#eafaf1` at 55% | Ambient blob behind a success composition |
| `wash-accent` | ≈`#f0ecfe` at 55% | Ambient blob behind an accent composition |

A wash is large, soft, low-opacity, sits **behind content inside a card**, never on the page ground, never crosses a card boundary, never sits under body text at an opacity that drops contrast below §3.7, never animates. Maximum two per screen.

### 3.6 Vendor and terminal

Vendor marks, used only in a vendor's own mark: `brand-claude` `#d86b47` · `brand-claude-soft` `#fff0e8` · `brand-claude-line` `#f6d9ca` · `brand-github` `#182235` · `brand-github-soft` `#f2f5fb`.

Terminal, a closed palette: `term-bg` `#14181f` · `term-line` `#2d3545` · `term-ink` `#d9e2f0` · `term-ink-soft` `#aab7ce` · `term-good` `#79d7aa` · `term-scroll` `#39445a`.

### 3.7 Contrast — measured

| Pair | Ratio | Verdict |
|---|---|---|
| `ink` on `surface` | 15.92 | pass |
| `ink-soft` on `surface` | 5.41 | pass — body and placeholder |
| `ink-soft` on `surface-sunken` | 5.17 | pass |
| `ink-soft` on `bg` | 5.00 | pass |
| `accent` on `surface` | 6.13 | pass |
| white on `accent` | 6.13 | pass |
| `accent-ink` on `accent-soft` | 7.96 | pass |
| `good` on `good-soft` | 5.50 | pass |
| `bad` on `bad-soft` | 5.46 | pass |
| `ink-faint` on `surface` | 3.12 | **non-text only** — gutter digits exempted |
| white on `gradient-primary` | 5.64 (start) · 4.99 (end) | pass at both ends |
| `violet` on `violet-soft` | 4.46 | pass — glyph only, 3:1 suffices |
| `warn` on `warn-soft` | 5.61 | pass |

### 3.8 Consolidation map

Every one of the 92 current colors resolves to a role above.

| Role | Absorbs |
|---|---|
| `line` | `#e5e9f1` `#e6ebf2` `#e1e7f0` `#e8edf4` `#edf0f5` `#e7ebf3` `#dce3ef` `#dce7f6` `#e4e8f0` |
| `ink-soft` | `#53627a` `#64728a` `#66758c` `#6b7a93` `#718099` `#7a879a` `#8490a2` |
| `accent` | `#5165d8` `#6174dd` `#2f65e8` |
| `accent-soft` | `#eef0fd` `#e9f0ff` `#f2f5ff` `#f2f4ff` `#f5f7ff` `#f7f8ff` |
| `accent-line` | `#cbd4f0` `#cad4f2` `#cfd8ff` `#cbd9ff` `#cbd8f5` |
| `accent-ink` | `#3348a5` `#34448f` |
| `good` | `#1f6542` `#1a7f37` `#4e8164` |
| `good-soft` | `#effaf3` `#e5f5ed` |
| `bad` | `#cf222e` |
| `bad-soft` | `#fff0f0` `#faeeee` |
| `warn` | `#9a6700` `#9a5f00` |
| `warn-soft` | `#fff3d5` `#fff7e5` `#fff8c5` `#fff1cc` |
| `surface-sunken` | `#fafbfd` `#fbfcfe` |
| `surface-muted` | `#f0f2f6` `#eeeeee` |
| `line-strong` | `#cbd5e3` `#c6cee2` `#dbe3ee` |
| `ink` | `#25324a` `#34415a` |
| `term-bg` | `#202938` |
| `ink-faint` | `#999999` |

### 3.9 Usage rules

- **One accent family** for every action and state. `violet` is a tile hue, not an accent.
- **Strategy: Restrained.** Neutrals, one accent, one gradient object — and that object exists only in onboarding.
- **State color is never the only signal.** Every colored state also has a shape, glyph or word.
- **Tone comes from state, never from a container.** A chip in a login card and a chip in a table read the same state token. Deriving tone from an ancestor is what produced a success-green `Pendente` in the shipped screen — fixed in `a60a961`; the rule exists so it cannot return by another route.
- **Hover changes ground, focus changes border.** Two signals, two jobs.
- **Dark by default**, by the user's choice: the product's night workspace (§3.10). Light is one click away in the app bar, and no screen picks a theme for itself.

### 3.10 Themes

The user picks the theme in the app bar (§25): **Escuro** (default), **Claro**, or **Sistema** (follows `prefers-color-scheme` and keeps following it while the page is open). The choice is stored per browser under `teams-ai.theme` and applied by an inline script in `index.html` before the first paint, so the page never flashes the wrong theme. The resolved theme is `data-theme="light|dark"` on `<html>`.

Dark remaps **the same roles**; no screen carries theme-specific selectors, and no screen picks a theme for itself.

**The dark world.** A third reference, supplied by the user, pins the dark theme: an AI workspace at night — a deep indigo-black room lit by violet and blue light, with glass panels floating over it. Six things carry that world, and every one of them lives in a token:

1. **Ambient light.** `bg-ambient` is one diagonal gradient across the whole window: violet in the top left, deep indigo through the middle, blue in the bottom right, fixed to the viewport so it never scrolls. The content sits straight on it, with no second background behind the cards. Light has none.
2. **Glass surfaces.** `surface`, `surface-sunken`, `surface-muted`, `line` and the soft state grounds are translucent, so the ambient light shows through every panel and a control inside a card reads one step lighter than the card.
3. **Glow, not edge.** The primary action and the panel icon tiles cast a violet glow with an offset and a blur (`shadow-accent`, `shadow-tile`); cards cast a deep soft shadow with a one-pixel top highlight.
4. **Saturated icon tiles.** `tile-accent`, `tile-violet` and `tile-good` are gradient fills with a white glyph in dark; in light they stay the soft ground with a colored glyph.
5. **Lit edges.** Raised surfaces (card, panel, stat, dialog) carry a lit rim: `edge-light` brightens the top edge with a hot spot near the top left and fades down the sides, and `edge-glint` adds a glowing line across the middle of the top edge. Both are `none` in light, and both only render where the browser supports mask compositing.
6. **Rounder geometry.** Cards, tiles and controls open up one radius step (`radius-xl` 16px, `radius-tile` 14px, `control-radius` 10px).

Contrast is measured on `surface` as it actually renders: blended over `bg` and over the brightest ambient spot. The lower figure is shown.

| Role | Dark value | Note |
|---|---|---|
| `bg` | `#070616` | Indigo-black |
| `bg-ambient` | `linear-gradient(135deg, #1b1446, #0e0c2a 38%, #080718 62%, #0c1134)` | One diagonal gradient, fixed to the viewport |
| `surface` | `rgb(23 21 54 / 0.72)` | Glass; renders between `#13112d` and `#19153b` |
| `surface-sunken` | `rgb(8 7 24 / 0.6)` | Insets sit darker than their panel |
| `surface-muted` | `rgb(255 255 255 / 0.06)` | Neutral chip, inline code |
| `line` · `line-strong` | `rgb(168 156 255 / 0.13)` · `0.26` | Lavender hairlines; they catch the light like a glass edge |
| `ink` | `#f0eeff` | 15.11:1 |
| `ink-soft` | `#a9a5cc` | 7.35:1 |
| `ink-faint` | `#6e6a98` | 3.43:1, non-text only |
| `accent` | `#5a35f0` | Fill only — white on it 6.56:1 |
| `accent-hover` | `#6a48ff` | White on it 5.27:1 |
| `accent-text` | `#ab9dff` | 7.40:1 |
| `accent-ink` / `accent-soft` | `#cdc3ff` / `rgb(110 80 255 / 0.18)` | 8.78:1 |
| `gradient-primary` | `linear-gradient(135deg, #7b4dff, #4a35f0)` | Still onboarding only (§3.3) |
| `tile-accent` · `tile-violet` · `tile-good` | gradients `#6d4bff→#4b2ee0` · `#b45cf0→#7a34d6` · `#199d78→#006f59` | White glyph, at least 3.4:1 |
| `good` / `good-soft` / `good-line` | `#58d8ae` / `#58d8ae` at 12% / at 30% | 9.82:1 on glass, 7.81:1 on its soft ground |
| `good-live` | `#35dcab` | The live dot and progress fills; same hue as `good`, a touch more saturated |
| `bad` / `bad-soft` / `bad-ink` | `#ff7d8a` / `rgb(255 90 110 / 0.12)` / `#ffc0c7` | 6.06:1 |
| `on-bad` | `#1c0a12` | Text on a `bad` fill — 7.76:1 |
| `warn` / `warn-soft` | `#f5d15c` / `rgb(245 209 92 / 0.12)` | 11.83:1 |
| `violet` / `violet-soft` | `#c79bff` / `rgb(190 110 255 / 0.16)` | 7.86:1 |
| `shadow-card` | `0 12px 40px -12px` near-black at 70%, plus a 1px top highlight | |
| `shadow-accent` · `shadow-tile` | `0 8px 24px -6px` · `0 6px 18px -4px` violet | The glow; light uses `shadow-button` and none |
| `backdrop-blur` | `10px` | Dialog backdrops blur in dark, so a glass dialog never shows text behind it |

- Glass here is the pinned world, not decoration: it is what lets the ambient light read through the interface. It never stacks more than two layers deep (a control inside a card), and text contrast is always measured on the blended result.
- Illustrations were drawn for a light ground: in dark they sit on a lavender plate (`art-plate` `#dedbf6`) instead of multiplying into the ground.
- The terminal palette (§3.6) is the same in both themes; in dark `term-bg` drops to `#05040f` so it still reads as a separate surface.
- **One green.** Every green in dark comes from one mint hue (168° in OKLCH), on the blue side of green so it sits with the violet and blue ground instead of fighting it. It matches the lightness and saturation of `bad` and `warn`, so no state shouts louder than another. A new green is derived from it, never picked fresh.
- Light keeps every value in §3.1–§3.5; the dark world never leaks into it.

---

## 4. Typography

### 4.1 The typeface

**Sans**

```
ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
"Helvetica Neue", Arial, sans-serif
```

**Mono**

```
ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
"Liberation Mono", monospace
```

Why no webfont: a well-tuned sans carries headings, buttons, labels, body and data — product UI needs no display/body pairing. Zero network cost, zero FOUT, zero layout shift; a setup screen that flashes unstyled text while the user is mid-login has spent its credibility on decoration. And it renders inside the OS the developer is already in, with native metrics at 13–15px where webfonts most often fail.

Corrections to the current stack: `ui-sans-serif` and `system-ui` lead so the browser's own UI face wins first. `"Avenir Next"` is removed — `-apple-system` already resolves the right macOS face, and Avenir Next ahead of `ui-sans-serif` yields different faces on different Apple configurations. `Roboto` added for Linux and Android.

The mono stack matters more here than in most products: it renders the spec editor, the CLI output and every diff. `ui-monospace` leads so macOS gets SF Mono and Windows gets Cascadia Mono where available, both of which have a taller x-height than Consolas at 13px.

If a branded face is ever adopted it is a whole-system decision: a metric-compatible fallback with `size-adjust`, `ascent-override`, `descent-override`; `font-display: swap`; only the weights used. Until then there is no `@font-face` in this project.

**Feature settings**

| Setting | Where | Why |
|---|---|---|
| `tabular-nums` | counters, token totals, costs, durations, numeric table columns, **the editor gutter** | digits must align and not jitter as a live value changes |
| `proportional-nums` | body prose | tabular figures in running text read as a table |
| `-webkit-font-smoothing: antialiased` | `body` | already present; keep |
| `text-rendering: optimizeLegibility` | **not used** | costs layout time, changes nothing at UI sizes |

### 4.2 Roles, not sizes

A role is a complete decision — size, weight, leading, tracking, default color. Naming sizes alone is what produced 30 of them.

| Role | Size | Weight | Leading | Tracking | Color | Use |
|---|---|---|---|---|---|---|
| `display` | 2.5rem ≥900px · 1.875rem below | 700 | 1.08 | −0.03em | `ink` | The onboarding flow's page title |
| `hero` | 1.5rem | 700 | 1.2 | −0.02em | `ink` | The headline inside a content card |
| `title` | 1.125rem | 650 | 1.30 | −0.01em | `ink` | Panel title, card heading |
| `subtitle` | 1rem | 600 | 1.35 | −0.005em | `ink` | Row heading, step title |
| `body` | 0.9375rem | 400 | 1.55 | 0 | `ink` | Prose |
| `body-soft` | 0.9375rem | 400 | 1.55 | 0 | `ink-soft` | Secondary prose, empty-state text |
| `ui` | 0.875rem | 500 | 1.40 | 0 | `ink` | Buttons, inputs, tabs, file rows, breadcrumb |
| `label` | 0.8125rem | 600 | 1.20 | 0 | `ink-soft` | Field labels |
| `meta` | 0.8125rem | 400 | 1.35 | 0 | `ink-soft` | Receipts, counters, hints, the meta line |
| `overline` | 0.75rem | 650 | 1.20 | 0.07em | `ink-soft` | Panel eyebrow, section headers, table headers |
| `code` | 0.8125rem | 400 | 1.60 | 0 | `ink` | Editor, codes, diffs, CLI output |

Eleven roles, ratio 1.07–1.17 through the dense range, then a deliberate jump to `hero` and `display` — the references earn that jump by giving a screen exactly one of each.

`display` switches at one breakpoint rather than `clamp()`. A fluid heading that shrinks inside a narrow column looks broken, not responsive; a two-step switch is structural.

### 4.3 The overline is promoted

In the first reference, `overline` was a table header and little else, and the system was going to retire it. The second reference makes it structural: `Área de trabalho`, `Refinamento`, `Controle de qualidade` sit above panel titles, and `HISTÓRICO`, `ARQUIVOS GERADOS`, `TAREFAS`, `SEGREDOS` divide a panel's interior.

So `overline` stays, with a tightened rule:

- **Above a panel title**, naming the panel's domain — sentence case, no icon.
- **As a section divider inside a panel**, with a 16px leading icon — uppercase, tracked.
- **As a table header** — uppercase, tracked, no icon.
- **Nowhere else.** It is still banned as an eyebrow above a page title (§15.1).

The two forms are distinguished by case and icon, never by size. One role, three placements.

### 4.4 Rules

- **Prose at 15px, dense UI at 14px, meta and code at 13px.** The current file runs prose at 13.6px — a control size doing a reading job.
- **Measure 45–75ch for prose.** A panel's prose column is capped, not full-bleed.
- **Leading is tuned per role.** `code` gets 1.6 because the editor's line-number gutter must align to it and because wrapped continuation lines (see the reference's line 11–12) need to read as one logical line.
- **Hierarchy uses size, weight, space and color together.** If `title` and `subtitle` cannot be told apart with the copy blurred out, one is unnecessary.
- **Repeated roles stay identical across screens and states.**
- **Never letter-space lowercase body text.** Positive tracking belongs to `overline` alone.
- **No gradient text.** Emphasis comes from weight and size.
- **Respect zoom and text scaling.** No `px` on type, no fixed-height container around wrapping text.

### 4.5 Stress cases

| Case | Requirement |
|---|---|
| 64-character login code | wraps inside its field, never widens the card |
| 40-character org or spec name | truncates with ellipsis + `title`, or wraps to its own line |
| A breadcrumb with four long segments | collapses middle segments to `…`, never wraps to two lines |
| A 200-character line in the editor | wraps with a continuation indent; the gutter numbers the logical line once |
| Two-line panel title at 320px | header grows; the tile stays top-aligned to the first line |
| Browser zoom 200% | reflows, nothing clips |
| PT-BR → DE expansion | no element sized to the current string's length |
| Font fallback miss | metrics close enough that no reflow is visible |

---

## 5. Iconography

### 5.1 The grid

| Property | Value |
|---|---|
| Canvas | 24 × 24 |
| Live area | 20 × 20 |
| Stroke | **1.5px as rendered** |
| Caps / joins | round |
| Corner radius | 2 on the 24 grid |
| Fill | none — the UI set is stroked |

**Rendered stroke, not attribute stroke.** An icon drawn on a 24 canvas and shown at 16px renders its stroke at two-thirds of the declared width: `stroke-width="2"` renders 1.33px at 16px and 2px at 24px, so one set looks thin in a button and heavy in a row. The rule is that the *rendered* stroke is 1.5px, so the attribute is `1.5 × 24 / displaySize`:

| Display size | `stroke-width` on a 24 canvas |
|---|---|
| 16px | 2.25 |
| 20px | 1.8 |
| 24px | 1.5 |
| 28px | 1.29 |

### 5.2 Sizes

| Size | Pairs with | Use |
|---|---|---|
| 14px | `meta` | Inside a chip |
| 16px | `ui`, `overline`, `label` | Buttons, section headers, file rows, leading field icons, breadcrumb |
| 20px | `subtitle`, `body` | Leading a list row, a menu item |
| 24px | `title` | Standalone, empty states |
| 28px | `hero`, panel titles | Inside a 48–56px icon tile |

Nothing between. An icon at 18px beside one at 20px reads as a mistake, never a nuance.

### 5.3 Icon tiles

Both references use them: the onboarding progress cube and success check, and the three panel-header tiles.

| Property | Value |
|---|---|
| Box | 56px standalone · **48px in a panel header** |
| Radius | `radius-tile` 14px (48px box) · 16px (56px box) |
| Ground | a `-soft` token: `accent-soft`, `violet-soft`, `good-soft`, `warn-soft` |
| Glyph | 28px at 56px box · 24px at 48px box, in the matching base color |
| Border | 1px of the matching `-line` token, or none — tiles carry no shadow |

A tile carries **one** glyph. **A tile is never decoration hunting for content: if the glyph does not name the thing the tile sits beside, delete the tile.** The 4.2rem brand tile in the current onboarding build is that failure — 67px of ornament pushing every title off the left guide.

**Tile hue encodes domain, not state.** Documents indigo, refinement violet, quality green. The tile does not change color when the panel's state changes; the chip does that.

### 5.4 Fill, stroke, vendor marks

The UI set is stroked, uniformly. Two sanctioned exceptions, reproduced as their owners ship them: the **GitHub** glyph (filled) and the **Claude** asterisk. A filled glyph reads heavier at the same box size, so it sits 1–2px smaller in the same box. Vendor marks render `ink-soft` when inactive and in full brand color only when active.

**Never mix fill and stroke in the same position across sibling rows.** The current build puts a filled GitHub glyph and a stroked Claude asterisk in the same slot on adjacent cards.

### 5.5 Alignment

- **Optical center, not box center.** An icon aligns to the **cap-height center** of adjacent text. With `align-items: center` on a flex pair this is automatic; inline, use `vertical-align: -0.125em`.
- **The icon box is square and equals the line-height of its text partner** — a 16px icon beside `ui` text sits in a 20px box, so the pair centers without per-icon nudging.
- **Gap:** 6px at 14px, 8px at 16px, 10px at 20px, 12px at 24px.
- **A leading icon inside a field** sits 12px from the field's left edge, is `ink-faint`, and the text inset accounts for it — the text never starts under the icon and never jumps when the field fills.
- **Directional glyphs align to the container's padding edge**, not an optical inset.
- **Optical nudges are measured on the render.** Asymmetric glyphs — play, send, external-link — sit visually left of center in a circular container and take +1px x. Symmetrical glyphs take none. The play glyph in `Iniciar análise` is the case in point.

### 5.6 Accessibility and naming

- Decorative icons carry `aria-hidden="true"`. `Icons.tsx` already does this; keep it.
- An icon-only control carries `aria-label`. An icon beside a visible label carries nothing.
- Names describe the **action or object**: `send`, `external`, `terminal`, `close` — never `paper-plane`, `arrow-box`, `x`.
- Stroke and geometry live in the shared `Icon` component. A `strokeWidth` prop at a call site is how a set drifts.

### 5.7 The set

Existing eight, audited:

| Icon | Canvas | Stroke | Verdict |
|---|---|---|---|
| `claude` | 32 | 2.7 | Off-grid canvas, off-set stroke. Keep 32 as a vendor mark with rendered weight matched to neighbours. |
| `github` | 24 | filled | Sanctioned vendor mark, 1–2px smaller than a stroked neighbour. |
| `user` `external` `send` `close` `terminal` `chevron` | 24 | 2 | Render 1.83px at 22px. Recompute per §5.1. `send` is asymmetric — check the nudge on render. |

To be drawn in the same grammar, for the screens in Parts II and III:

`arrow-left` · `arrow-right` · `check` · `check-square` · `folder` · `home` · `key` · `lock` · `building` · `file-text` · `clipboard` · `shield` · `lightbulb` · `clock` · `copy` · `download` · `pencil` · `play` · `info` · `list`

---

## 6. Illustration and celebration

Onboarding only. An asset class without rules becomes a stock-art drawer.

| Property | Rule |
|---|---|
| Subject | The product doing its job — a window, a list, a set of items. Never a person, never a metaphor (rockets, trophies, lightbulbs as pictures). |
| Construction | Soft dimensional shapes, `radius-tile`-family corners, gentle drop shadows, no outlines. |
| Light | One direction, top-left, consistent across every asset. |
| Palette | `accent`, `accent-2`, `violet`, `good-bright`, `warn`, `info`, plus the neutral ramp. Nothing outside the token set. |
| Contrast | Low. The illustration supports the headline; it never out-weighs it. |
| Detail | No legible text inside an illustration. Text is drawn as gray bars. |
| Format | SVG. Inline where it must re-color, a file otherwise. |
| Placement | One per screen, beside the content, never behind text. `aria-hidden`. |

**Celebration marks** — the confetti around the success tile, the sparkle cluster.

- **Once per flow, on the terminal screen only.** A celebration on every step is noise.
- Same grammar: rounded strokes, 3–5 marks, four hues maximum, asymmetric.
- **Static by default.** If animated: once, on entry, under 500ms, removed entirely under `prefers-reduced-motion`.
- Never marks a routine success. A saved field, a passed check, a closed item — those get a chip.

---

## 7. Space, grid and alignment

### 7.1 The scale

4px base. Permitted: **4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64**. Nothing between. A 4-unit base is chosen over 8-only because a dense product UI needs the 12 and 20 that an 8-scale rounds away; 6 is admitted for the one job an icon–text gap at 14px needs.

### 7.2 Rhythm

- **Group by meaning, proximity before containers.** A border around related fields is compensation for spacing that failed to group them.
- **Deliberate contrast between tight and generous.** Related items 4–8px; sections inside a panel 24–32px; panels 24px apart.
- **More space above a heading than below it.** A section overline sits 28px below what precedes it and 12px above what follows.
- **`gap` for sibling rhythm.** Child margins make a component's spacing depend on its neighbours.

### 7.3 Alignment laws

Each closes a specific defect in the current build.

**1. Two vertical guides per container.** Everything inside a card aligns to a content-left and a content-right guide. Nothing is *almost* aligned. A 4.2rem brand tile pushing its title 12px right of every other title breaks the left guide. In the refinement reference every section header, field, file row and the footer button all resolve to the same two guides — that is the single thing making three dense panels read as calm.

**2. A fixed leading column.** Where rows carry a marker, icon or tile, that column has a fixed width, so **every title starts at the same x**. A leading element sized by its own content makes a list ragged even when each row is internally correct.

**3. Baseline, not center, for mixed type sizes.** A row holding a `title` and a `meta` value aligns on the first baseline. Centering two different sizes makes both look off — the eye reads the baseline, not the box.

**4. Bottom alignment for control rows with labels; center without.** When some controls carry a label above and others do not, `align-items: end` puts every field on one baseline. `center` floats the unlabelled controls into the label's whitespace.

**5. Numbers right-align, in tabular figures.** Token counts, costs, durations. The editor gutter is right-aligned for the same reason.

**6. One action baseline.** All actions for one unit sit on one horizontal baseline, primary rightmost. An action stranded below a divider in the lower-left is not a layout, it is leftover space.

**7. Text alignment is left, always.** Centering is reserved for a single line inside a chip or a button, and for an empty state's two lines under its icon. Neither reference centers anything else.

**8. Panel headers align across columns.** Three side-by-side panels put their tiles, overlines, titles and chips on the same four horizontal lines. A panel whose header is 4px taller than its neighbours breaks the row even though each panel is internally correct.

**9. Optical corrections are made on the render.** Circular containers, asymmetric glyphs and tracked uppercase need the screenshot before the nudge.

### 7.4 The squint test

Blur until the copy is unreadable. The primary element, the secondary element and the group boundaries must still be identifiable **in order**. Both references pass. The current onboarding page fails: five equal blocks.

---

## 8. Radius

| Role | Value | Use |
|---|---|---|
| `radius-xs` | 4px | Tiny marks |
| `radius-sm` | 6px | Inline code, small controls, segmented-control items |
| `radius-md` | 8px | Inputs, buttons, file rows, callouts |
| `radius-lg` | 10px | Editor, inset boxes, lists, empty-state boxes |
| `radius-tile` | 12px | Icon tiles |
| `radius-xl` | 12px | Panels and cards |
| `radius-2xl` | 16px | The onboarding content card |
| `radius-pill` | 999px | Pills, tracks |
| `radius-circle` | 50% | Dots |

Replaces 15 arbitrary values including `9px`, `14px`, `16px`, `1.1rem`, `24px` and the compound `24px 24px 1.2rem 1.2rem`. The scale was tightened one step after review: 18–20px panels read as a template rather than a tool.

**Nesting rule.** One frame owns the largest radius on a screen; nothing inside may equal or exceed it. A nested radius should be roughly `outer − padding` so the curves stay concentric — the reference's 12px editor inside an 18px panel with 24px padding obeys this; a 12px inner inside a 14px outer would not.

---

## 9. Elevation

Softer and wider than the current build, matching the references' near-invisible borders carried by diffuse shadow.

| Role | Value | Use |
|---|---|---|
| `shadow-card` | `0 1px 2px rgb(24 34 53 / .04), 0 2px 8px rgb(24 34 53 / .04)` | Panels and cards |
| `shadow-button` | `0 1px 2px rgb(24 34 53 / .08)` | Raised controls: the flat primary, the selected theme option |
| `shadow-primary` | `0 4px 12px rgb(74 84 232 / .22)` | **The onboarding gradient button only** |
| `shadow-pop` | `0 10px 24px rgb(24 34 53 / .16)` | Overlays, menus, tooltips |

Rings are **state**, not depth: `ring-focus` `0 0 0 3px rgb(67 87 199 / .22)`. The colored glow under buttons and the 32px card bloom were removed after review: they were the strongest "generated" tell on the screens.

**Rules**

- One elevation level per visual plane. A shadowed element inside a shadowed element inside a shadowed page means nothing is raised.
- Chips, inputs, file rows, editors, tabs and dividers carry **no** shadow. In the reference every one of those sits flat inside its panel; only the panel is raised.
- Every shadow has an offset and a blur. A zero-offset colored halo is decoration, not depth.

---

## 10. Motion

### 10.1 Should this animate at all?

| Seen how often | Decision |
|---|---|
| 100+ times a day — tab switches, editor typing, keyboard shortcuts | **No animation.** Ever. |
| Tens of times a day — hover, row navigation, disclosure | Reduce drastically: color only, 140ms |
| Occasional — a step advancing, an analysis starting | Standard animation |
| Rare — first run, the completion screen | May carry delight |

**Never animate a keyboard-initiated action**, and never animate a tab change in the document workspace — a developer switching between `project.md` and `briefing.md` does it dozens of times per session and every millisecond of transition reads as lag.

### 10.2 Purpose

Every animation answers "why does this move?" with one of: spatial consistency, state indication, feedback, preventing a jarring appearance. On the onboarding terminal screen a fifth is legitimate once: celebration.

### 10.3 Easing and duration

| Situation | Curve |
|---|---|
| Entering or exiting | `ease-out` |
| Moving or morphing on screen | `ease-in-out` |
| Hover, color change | `ease` |
| Progress fill | `linear` |

`ease-out` = `cubic-bezier(0.23, 1, 0.32, 1)` · `ease-in-out` = `cubic-bezier(0.77, 0, 0.175, 1)`

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching most closely; `ease-in` at 300ms *feels* slower than `ease-out` at the same 300ms. The built-in CSS keywords are too weak to read as intentional.

| Element | Duration |
|---|---|
| Button press feedback | 100–160ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects, disclosures | 150–250ms |
| Screen transition | 200–260ms |
| Progress fill | up to 350ms |

Tokens: `duration-fast` **140ms** · `duration-base` **220ms** · `duration-slow` **350ms**. **Ceiling: 300ms for anything the user waits on.**

### 10.4 Rules

- **Never `transition: all`.** Name the properties; `all` animates layout you did not intend and costs frames.
- **Animate `transform`, `opacity`, `filter`.** These skip layout and paint. For height use `grid-template-rows: 0fr → 1fr`, never `height`.
- **Transitions, not keyframes, for anything retriggerable.** Transitions retarget from their current position; keyframes restart from zero.
- **Never enter from `scale(0)`.** Enter at `scale(0.96)` with `opacity: 0`.
- **Origin-aware popovers** scale from their trigger. Modals are the exception — unanchored, so centered.
- **One authored moment per screen.**
- **Controls do not move under the cursor.** Press feedback is `filter: brightness(.96)`, not `transform: scale()`.
- **Exit faster than enter.**
- **Gate hover** behind `@media (hover: hover) and (pointer: fine)`.
- **`prefers-reduced-motion` reduces, it does not delete.** Keep opacity and color; remove movement, position change and every celebration. State stays legible.

---

## 11. Component families

Each specified once. Variants assign values; they never redeclare geometry.

### 11.1 Surface

| Variant | Border | Radius | Ground | Elevation | Padding |
|---|---|---|---|---|---|
| `panel` | 1px `line` | `radius-xl` | `surface` | `shadow-card` | 24px |
| `content-card` | 1px `line` | `radius-2xl` | `surface` or `tint-good` | `shadow-card` | 40px |
| `inset` | 1px `line` | `radius-lg` | `surface-sunken` | none | 16px |
| `row` | 1px `line` | `radius-md` | `surface` | none | 10px 12px |

**Cards are the lazy container.** A card inside a card is always wrong. An `inset` groups content inside a panel and is never nested further. The refinement reference obeys this: three panels, each containing insets and rows — and not one panel inside a panel.

### 11.2 Panel header

The pattern the second reference establishes, used by every panel in the app.

```text
┌──────────────────────────────────────────────────────┐
│  ▣   Área de trabalho                    [ ✎ Editável ] │
│      Documentos do projeto                            │
└──────────────────────────────────────────────────────┘
```

| Element | Spec |
|---|---|
| Tile | 48px, `radius-tile`, domain hue (§5.3) |
| Overline | `overline`, sentence case, no icon, no tracking above 0.07em |
| Title | `title`, 2px below the overline |
| Chip | §11.4, top-right, aligned to the **overline's** baseline, not the title's |
| Gap | 14px tile → text |
| Bottom | 20px, then the panel body. **No divider rule** — the tile and the space do the separating. |

Across side-by-side panels, tile, overline, title and chip all sit on the same four horizontal lines (law 8).

### 11.3 Button

**Label, then one icon.** Every action button and button-styled link shows its label followed by exactly one icon: 16px on regular buttons, 14px on compact row buttons. The icon names the action (`Excluir` trash, `Nova spec` plus, `Abrir` arrow, `Abrir no GitHub` external), never decorates it, and a button never carries two icons. Exceptions, because they are not labelled actions: the icon rail and the theme control (icon toolbars with an accessible name and a tooltip), the info tips, tabs, breadcrumb links, and text buttons inside lists such as task ids.

**Size.** Every button with text is at least as wide as the primary button (`--button-min-width`, 9rem) and 2.5rem tall (`--control-height`), so actions line up; a longer label still widens its button. Icon buttons, tabs, table headers and inline text links are exempt.

| Variant | Ground | Text | Border | Hover | Use |
|---|---|---|---|---|---|
| **primary** | `gradient-primary` + `shadow-primary` | white | none | `gradient-primary-hover` | the one main action, app-wide |
| **primary-flow** | `gradient-primary` + `shadow-primary` | white | none | ramp darkens 6% | **onboarding only** |
| secondary | `surface` | `accent-ink` | 1px `accent-line` | ground `accent-soft` | alternate action |
| default | `surface` | `ink` | 1px `line-strong` | ground `surface-sunken` | back, neutral |
| quiet | transparent | `ink-soft` | none | `ink` + 2px underline at 3px offset | disclosure, tertiary |
| icon | transparent | `ink-faint` | none | `ink-soft`, ground `surface-muted` | copy, download, close |
| destructive | `bad` | white | none | darkened | delete, revoke |

Height **40px** in-app, **44px** in the onboarding flow, **32px** for `icon`. Radius `radius-md`. `ui` role at weight 600. Leading icon 16px, trailing arrow 16px, gap 8px, horizontal padding 16px (20px on a primary, 0 on `icon`).

- **Full width** is legitimate for a panel's terminal action — `Iniciar análise` — when that action is the panel's whole purpose and nothing competes with it.
- **Disabled:** 48% opacity, `not-allowed`, plus a reason wherever the user could not guess it. A disabled primary keeps its gradient at 48%.
- **Loading:** label replaced, control disabled, **control not removed** — removing it mid-flow collapses the layout under the pointer.
- **One primary per screen.** The refinement screen has two visible — `Avaliar` and `Iniciar análise` — and that is the one sanctioned exception: they belong to **different panels with different jobs**, and no panel has two. The rule is one primary per panel, one per screen where the screen is a single unit.
- A destructive action is never the default focus target and never sits beside the primary without a larger gap.

### 11.4 Chip

One shape, two variables, an optional leading mark.

Shape: inline-flex, 6px gap, 5px/10px padding, `radius-pill`, `meta` size at weight 600, `nowrap`. The leading mark is **either** a 7px dot from `currentColor` **or** a 14px icon — never both, never neither by accident.

| Tone | Text | Ground |
|---|---|---|
| neutral | `ink-soft` | `surface-muted` |
| good | `good` | `good-soft` |
| bad | `bad` | `bad-soft` |
| warn | `warn` | `warn-soft` |
| accent | `accent-ink` | `accent-soft` |
| info | `ink` | `info-soft` |

**Dot or icon?** A dot for a state that is simply on or off — `Atual`, `Concluído`. An icon where the chip names a capability or a count — `Editável` with a pencil, `0 em aberto` with a clock. Replaces nine implementations. Tone is assigned by the element's own state class — never by an ancestor. In code the tones are `tone-good`, `tone-bad`, `tone-warn` and `tone-neutral`; `tone-bad` marks a handled failure and paints in the warn colour, so red stays for unexpected errors and destructive actions; `tone-neutral` is the **accent** tone and marks work in progress (`em execução`, `finalizando`).

### 11.5 Callout

One box, three variables, an optional leading icon.

Shape: 14px padding, 1px border, `radius-lg`, `body` size, 16px leading icon at 10px gap, top-aligned to the first line.

| Tone | Text | Ground | Border |
|---|---|---|---|
| error (handled) | `warn` | `warn-soft` | `warn-line` |
| error (unexpected) | `bad` | `bad-soft` | `bad-line` |
| warning | `warn` | `warn-soft` | transparent |
| success | `good` | `good-soft` | `good-line` |
| guidance | `ink` with an `accent-ink` lead-in | `accent-soft` | `accent-line` |
| neutral | `ink` | `surface-muted` | `line` |

The `guidance` tone is the reference's `Próximo passo:` box — a bold accent lead-in followed by `ink` body, so the sentence stays readable while its label stays scannable. Replaces six implementations with six different paddings. A callout names the problem **and** the recovery.

### 11.6 Field

Shape: 40px in-app (44px in the flow), 0/12px padding, 1px `line-strong`, `radius-md`, `ui` role, `ink` on `surface`. Placeholder `ink-soft`.

**Leading icon variant.** A 16px `ink-faint` icon 12px from the left edge; text inset 38px. Used where the field's subject is a kind of thing rather than a free value — a person's name, a search term. Not on a secret or a code field, where the icon would compete with a masked value.

| State | Treatment |
|---|---|
| focus | border `accent` + `ring-focus`, no offset jump |
| error | border `warn` + ring in warn tone, message below in `meta` `warn` |
| disabled | ground `surface-sunken`, border `line`, text `ink-soft` |
| read-only | ground `surface-sunken`, border `line`, text `ink` |

Labels are real `<label>` elements above the field, `label` role, 6px between. A field never relies on its placeholder as its label — the reference's `PO` and `SM` labels are correct and stay.

### 11.7 Tabs

Underline tabs, for switching between peer documents.

| Element | Spec |
|---|---|
| Strip | 1px `line` bottom rule spanning the panel's content width |
| Tab | `ui` role, 10px/14px padding, `radius-md radius-md 0 0` |
| Rest | `ink-soft`, transparent ground |
| Hover | `ink`, ground `surface-sunken` |
| Active | `accent-ink`, ground `accent-soft`, 2px `accent` bottom border overlapping the strip rule |
| Focus | the system ring, inset so it is not clipped by the strip |

**No transition on the active state.** Tab switching is a hundred-times-a-day action (§10.1).

Semantics: `role="tablist"` / `role="tab"` / `aria-selected`, arrow-key navigation, and the panel is `role="tabpanel"` labelled by its tab.

### 11.8 Code editor

| Element | Spec |
|---|---|
| Frame | `inset`, `radius-lg`, `surface-sunken`, 1px `line` |
| Gutter | 44px, right-aligned digits, `code` role in `ink-faint`, tabular, 1px `line` right rule |
| Content | `code` role at 1.6 leading, `ink`, 14px left of the rule |
| Wrapping | soft-wrapped with a continuation indent; the gutter numbers the **logical** line once |
| Copy | `icon` button, top-right, 12px inset, `ink-faint` → `ink-soft` on hover |
| Height | capped, with its own scroll; never grows the panel |
| Selection | `accent-soft` ground, `accent-ink` text |

The gutter is the one place `ink-faint` renders characters (§3.1).

### 11.9 Section header

The in-panel divider the second reference establishes: `HISTÓRICO`, `ARQUIVOS GERADOS`, `TAREFAS`, `SEGREDOS`.

16px icon in `ink-soft`, 8px gap, `overline` uppercase. 28px above, 12px below. **No rule line** — space and the icon do the work. A section header always has content beneath it, even if that content is an empty state.

### 11.10 File row

`row` surface, 10px/12px, `ui` role. Leading 16px chevron (`ink-faint`, rotates 90° when expanded), filename in `ink`, trailing `icon` button for download. Whole row is the expand target; the download button is not. Rows stack with 8px gaps, never a shared border. The one exception is the agent list in Configurações, whose rows separate with `accent-line`.

### 11.11 Empty state

| Context | Shape |
|---|---|
| Inline, one line | An `inset` box, `body-soft`, left-aligned: `Nenhum registro no momento.` |
| Sectional | An `inset` box, centered: 24px `ink-faint` icon, one `body` line naming what goes here, one `body-soft` line saying how it gets there |

The second form is the reference's `Nenhuma tarefa gerada ainda. / As tarefas aparecerão aqui após a análise.` — it teaches the interface. Neither form apologises, and neither says "nothing here".

### 11.12 Meta line

Middot-separated facts in `meta`, tabular figures, no labels: `0 etapas · 0 tokens · US$ 0.00`. Sits immediately above the action it describes, 12px below the last section. A value never moves when it changes — the separators stay put because every number is tabular.

### 11.13 Panel footer

A `line` top rule, 16px padding, then: an `info` icon plus `meta` explanation at the left guide, a primary action at the right guide when the panel has one, on one baseline. The reference's `As alterações são salvas automaticamente ao sair do editor.` is the pattern for a panel with no action; the documents panel has none, since `Avaliar` moved to the review panel (§26.2). The explanation says what the system does; the button says what the user does.

### 11.14 Breadcrumb

A single `ui` row above everything, outside the panels.

| Element | Spec |
|---|---|
| Home | 16px `home` icon, `ink-soft`, links to `/` |
| Separator | 16px `chevron-right`, `ink-faint`, 8px either side |
| Ancestor | `accent`, underline on hover |
| Current | `ink-soft`, **not a link**, no underline |
| Overflow | middle segments collapse to `…` with a menu; never wraps to two lines |

Semantics: `<nav aria-label="Trilha">` wrapping an `<ol>`, current segment `aria-current="page"`.

### 11.15 Terminal and diff

A content surface, not a card: `term-bg`, `radius-lg`, 14px padding, `code` at 1.6 leading, `pre-wrap`, `overflow-wrap: anywhere`, capped height with its own scroll. Header in `overline` `term-ink-soft`; a live indicator in `term-good` only while a stream is actually open.

Light-on-dark needs compensation on all three axes: one step more leading, slightly more tracking, one step more weight than the same role on a light ground. Scrollbar themed — 10px, `term-scroll` thumb, `radius-pill`, 3px `term-bg` inset border.

### 11.16 Table

`ui` role. Header cells `overline` with a `line` bottom rule. Body cells 9px/10px, top-aligned, `line` bottom rule, none on the last row. Row hover `surface-sunken`. Numeric columns right-aligned, tabular. Column widths declared, not content-derived. Inside a container narrower than 44rem a table becomes a list of cards: each row a card, each cell a line with its column name above the value, and the header hidden.

### 11.17 Progress

Track 6px, `radius-pill`, `surface-muted`. Fill `radius-pill`, `transform: scaleX()` from the left, `duration-slow` `ease-out`. In the onboarding flow the fill is `gradient-primary`; anywhere else it is flat `accent`, except a bar that counts finished work (the run's merged tasks), which fills in `good`.

### 11.18 Browser surfaces

The parts nobody drew still carry the design, and shipping them as browser defaults is the cheapest tell that a page was assembled rather than built. All themed: text selection (`accent-ink` on `accent-soft`), caret (`accent`), form `accent-color`, focus ring, link underline offset and thickness, scrollbars on the editor and the terminal, tabular figures wherever numbers are compared. `color-scheme` follows the theme so native controls and scrollbars switch with it.

### 11.19 Info tip

Every metric, status or term a first-time user could misread carries an explanation one hover away: a 14px `info` glyph in `ink-faint` beside its label (`InfoTip`). Hover or keyboard focus shows a bubble — `tooltip-bg` / `tooltip-ink`, `radius-md`, `shadow-pop`, max 17rem, one or two short sentences — positioned `fixed` so scrolling tables and clipped lists never cut it. `Escape` dismisses it. The explanation is the button's accessible name, and the bubble exists only while shown.

- One tip per concept, beside the concept's label — never on every repetition of it.
- The label itself must already be the best short name; the tip explains, it does not rescue a cryptic label.
- Plain Portuguese, no jargon the tip itself would need to explain.

---

## 12. State model

Every interactive component supports the full set. Half of these is half a component.

| State | Requirement |
|---|---|
| default | — |
| hover | ground change, no movement, gated behind a fine pointer |
| focus-visible | the system ring, one definition, never removed |
| active | `brightness(.96)` |
| disabled | 48% opacity, `not-allowed`, plus a reason where not obvious |
| loading | label replaced, control disabled, control not removed |
| error | `warn` border + ring, message naming problem and recovery |

For anything rendering a collection, add **empty** and **skeleton**. Empty states teach the interface (§11.11). Loading uses skeletons shaped like the content, not a spinner in the middle of it.

---

## 13. Accessibility baseline

- **Contrast:** body and placeholder ≥4.5:1, large text and glyphs ≥3:1. §3.7 is the verified table; `ink-faint` is non-text except the editor gutter; the gradient's light end, the violet tile and the sampled warn ground are unverified and must be measured.
- **Focus:** one ring app-wide — 2px `accent`, 2px offset, never removed. Focus order matches visual order. Inside the editor, focus is the caret, not the ring.
- **State is never color-only.** Shape, glyph or word accompanies every colored state.
- **Targets:** 40px for every button with text, in-app and in the flow; 32px for icon buttons — with a 44px hit area on coarse pointers via padding, not by growing the visual control.
- **Semantics:** tabs are a real tablist; the breadcrumb is a `nav` + `ol` with `aria-current`; disclosures are `<button aria-expanded>`; the flow is an ordered list of steps with `aria-current="step"`; disabled items carry `aria-disabled` plus a visible reason; icon-only controls carry `aria-label`.
- **Live regions:** analysis progress, step state and any change that happens without a click are announced `polite`.
- **Illustrations are `aria-hidden`.**
- **Motion:** `prefers-reduced-motion` removes travel and celebration, not state.
- **Overlays escape their container.** An absolutely positioned menu inside an `overflow: hidden` or `overflow: auto` ancestor gets clipped — and the refinement screen has three scrollable panels, so this is a live hazard. Use `<dialog>`, the popover API, `position: fixed`, or a portal.

---

## 14. CSS conventions

### 14.1 Architecture

Cascade layers, in order: **theme → base → components → utilities**, with the tokens unlayered above them. Tokens hold every literal; `components` holds the primitives; utilities in the markup compose screens and always win over a primitive.

| Layer | Contains | Literals? |
|---|---|---|
| `tokens` | role definitions only | **yes — the only place** |
| `primitives` | the families in §11, each once | no |
| `app` | layout, composition, screen rules | no |

Explicit layering means a surface rule wins over a primitive without a specificity contest. 209 selectors in one flat file is how a container selector came to beat a state selector. Adoption is incremental: legacy class names may alias onto a family's single definition, so the system lands without touching JSX.

**Files today.** The app uses Tailwind CSS v4 without its reset. `web/src/styles.css` holds the tokens (both themes), exposes them to Tailwind through `@theme` (so `bg-surface`, `text-ink-soft`, `shadow-card`, `rounded-tile` follow the theme), and keeps the shared primitives of §11 in the `components` layer. Screens and components style themselves with utilities in their markup; there are no per-screen stylesheets. The Tailwind palette is switched off, so only project tokens can be used as colors.

### 14.2 Selectors

- **Budget: two class selectors.** `.panel-footer > .primary` is the ceiling.
- **No IDs. No `!important`** — one exception, the `prefers-reduced-motion` block.
- **No element selectors in the app layer.** Styling `button` globally belongs to primitives; doing it again in a screen rule is how a control ends up with three competing heights.
- **State is a class on the element, never an ancestor:** `.is-active`, `.is-loading`, `.tone-bad`.
- **No `:not()` chains** undoing a rule that should not have been that broad.

### 14.3 Declaration order

**layout → box → typography → visual → motion.**

```
display / position / grid / flex  →  width / height / margin / padding / border
→  font / color / text  →  background / box-shadow / opacity  →  transition / animation
```

### 14.4 Custom properties

- **Component-local variables are declared on the component root**, not globally: a chip declares `--chip-ink` / `--chip-bg` on itself and tone classes assign them. This collapses nine chip implementations into one.
- **Never update an inherited custom property on a parent during an animation.** Changing a variable on a container recalculates styles for every descendant; write `transform` on the element that moves.
- Global tokens are read, never reassigned outside the token layer.

### 14.5 Layout mechanics

- **`min-width: 0` on every grid and flex child** that can receive long content. Without it a long spec name or org name widens its whole column instead of wrapping — and the refinement screen is three columns of user content.
- **`overflow-wrap: anywhere`** on every user-supplied string.
- **`gap` over child margins.**
- **Responsive behavior is structural** — reorder, collapse, reflow, reveal. Not fluid type.
- **Breakpoints are Tailwind's:** `sm` 640px, `md` 768px (rail becomes a bottom bar), `lg` 1024px (Workspace panels go side by side), `xl` 1280px. Another needs a named reason.
- **Breakpoint rules live with the component they modify**, not in a global tail block.
- **Container queries** where a component appears at more than one width — the panel header does, so it is a container-query component.
- **No `overflow: hidden` on an ancestor of anything that pops** (§13).
- **A scrollable panel owns its scroll**, with the header pinned and the body scrolling — never the whole column.

### 14.6 Direction and locale

PT-BR only, LTR. Logical properties are **not required**, and adopting them halfway is worse than not at all. A second locale is one mechanical pass, tracked as such.

### 14.7 Hygiene

- A selector with no matching JSX is deleted in the change that orphaned it.
- A change removes the imports, variables and rules **its own edit** made unused. Pre-existing dead code is reported, not silently deleted.
- No commented-out CSS in a merged change.
- Values used once stay inline; the token layer is not a dumping ground.

---

## 15. Patterns

**Page shell.** Breadcrumb row, then content. No page title where the breadcrumb already names the thing — the refinement reference has no `<h1>`, and it does not need one.

**Panel.** Header (§11.2), body, optional footer (§11.13). Sections inside it are divided by §11.9 headers, never by rules.

**Flow header.** `display` title left, one `body-soft` line beneath, progress card right on the title's optical center, a `line` rule below. Onboarding only.

**Form row.** Label above field; field and its action on one baseline, bottom-aligned; action rightmost; error callout full-width beneath.

**Action row.** All actions for one unit on one baseline, primary rightmost, quiet actions leftmost, a destructive action separated by a larger gap.

**List row.** Fixed leading column, flexible content, auto trailing. Baseline-aligned. Hover changes ground only.

**Disclosure.** A `quiet` button or a `row` with a rotating chevron, `aria-expanded`, closed by default, revealed with `grid-template-rows` rather than `height`.

**Loading.** Skeletons shaped like the content, on `surface-sunken`, no shimmer sweep. A spinner only where the wait is genuinely indeterminate and unshaped.

**Confirmation.** Inline where reversible. A `<dialog>` only when destructive and irreversible, with the destructive verb on the button — never "OK".

### 15.1 Anti-patterns

| Anti-pattern | Instead |
|---|---|
| Same-size cards of icon + heading + text as the page structure | Panels with real hierarchy |
| A card inside a card | Space, or one inset, never nested |
| A gradient anywhere outside the onboarding flow | Flat `accent` |
| Gradient text | Weight or size |
| Two gradient objects on one screen | One |
| An icon tile whose glyph does not name its neighbour | Delete the tile |
| A tile that changes hue with state | The chip carries state; the tile carries domain |
| Celebration on a routine success | A chip |
| An illustration behind body text | Beside it |
| An eyebrow above a **page** title | Delete it — `overline` above a **panel** title is the sanctioned form |
| A rule line under every section header | Space and the icon |
| Animating a tab change | No transition |
| Modal as the first thought | Exhaust inline and progressive alternatives |
| Section numerals (01 / 02 / 03) | Only when the sequence is itself information |
| Glass and blur as decoration | A specific effect with a specific job |
| A colored `border-left` above 1px | Tone the ground |
| Hard offset shadow (`4px 4px 0`) | This is not a neobrutalist world |
| Shadow on a chip, input, row or tab | Only the panel is raised |
| Unicode glyph or emoji as an icon | A drawn icon from the set |
| Monospace as a costume for "technical" | Code, data and measurement only |
| Light or dark picked by category | Picked from the use scene |

---

## 16. Governance

**Adding a token** requires three existing uses with one intent. **Adding a component** requires all seven states in §12 specified before it ships.

**Review checklist** — answerable with evidence, not intention:

| Check | Evidence |
|---|---|
| No literal color, size, shadow or radius outside `tokens` | grep the diff |
| No gradient outside the onboarding flow | screenshot |
| Every new role maps to §4.2, every size to §7.1, every radius to §8 | read the diff |
| Contrast on every new text/ground pair, including both gradient ends | measured ratio |
| All seven states on every new control | rendered screenshots |
| Panel headers align across columns (law 8) | overlay guides on a screenshot |
| Focus visible everywhere, keyboard order = visual order, tabs arrow-navigable | tab through it |
| No `transition: all`; only transform/opacity/filter animated; no tab transition | grep the diff |
| `prefers-reduced-motion` removes travel and celebration, not state | toggle it |
| Squint test reveals primary → secondary → groups | blurred screenshot |
| Long content, empty state, 200% zoom hold in all three columns | screenshots at the extremes |
| No popover clipped by a scrollable panel | open every menu at the panel's scroll extremes |
| No selector orphaned by this change survives it | grep the class names |

---

# Part II — The onboarding flow

## 17. Structure

A **stepped wizard**: one screen per step inside a single shell. The page title sits above the shell. Inside the shell: a labeled horizontal stepper (6 nodes), the step body, and a footer with `Voltar` and `Continuar`. The completion screen counts as step 6 (`Pronto`).

| # | Screen | Item | Stepper label | Gate |
|---|---|---|---|---|
| 1 | GitHub CLI | `ghLogin` | Conectar GitHub | — |
| 2 | Token do GitHub | `githubToken` | Token | step 1 done |
| 3 | Organização do GitHub | `githubOwner` | Organização | step 2 done |
| 4 | Claude | `claude` | Claude | — |
| 5 | Chave do OpenRouter | `openrouterKey` | OpenRouter | — |
| 6 | Tudo pronto | — | Pronto | steps 1–5 done |

Order is fixed; advancing requires the current item `ok`. A successful save or login advances automatically; `Continuar` remains for already-complete steps.

## 18. Screen shell

```text
  Configure este ambiente
  Conecte as ferramentas que o Teams AI precisa para trabalhar neste computador.
  ┌─────────────────────────────────────────────────────────────────────┐
  │  (1) Conectar GitHub — (2) Token — (3) Organização — … — (6) Pronto │
  ├─────────────────────────────────────────────────────────────────────┤
  │  ▣  Título                          [chip]   │  Painel ilustrado     │
  │  apoio                                       │  headline + suporte   │
  │  [benefício] [benefício]                     │  illustration PNG     │
  │  detalhe + controles                         │                       │
  ├─────────────────────────────────────────────────────────────────────┤
  │  [ ← Voltar ]                                      [ Continuar → ]  │
  └─────────────────────────────────────────────────────────────────────┘
```

| Region | Spec |
|---|---|
| Page header | `display` title; `body-soft` intro capped at 60ch |
| Shell | one `edge-lit` panel, `radius-2xl`, max width 1120px |
| Stepper | six numbered nodes with short labels; active uses gradient node; done uses accent soft + check |
| Body | two columns ≥720px: task left, illustration panel right |
| Footer | `Voltar` left; `Continuar` right (hidden on step 6), enabled only when the current item is `ok` |

## 19. A task step (screens 1–5)

| Element | Role |
|---|---|
| Tile | 56px domain icon (GitHub or Claude) |
| Chip | `Pendente` (warn + clock), `Verificando`, or `Concluído` |
| Headline | the connection name |
| Support | `body-soft`, ≤2 lines |
| Benefits | two micro-cards (icon + title + one line) |
| Control | login or `Salvar e continuar` |
| Panel | headline + support + the step PNG — consistent on all five setup steps |

| State | Chip | Control |
|---|---|---|
| `pending` | `Pendente` warn | primary enabled |
| `active` | `Verificando` | primary loading |
| `done` | `Concluído` good | auto-advance or `Continuar` |
| `failed` | — | error callout + retry |

## 20. The CLI login (screens 1 and 4)

`starting` → `awaiting-browser` → `awaiting-code` → `verifying`, rendered **inside the content card**, on the card ground, with no nested container. The current build's bordered, tinted code form is a card inside a card.

- **One baseline**, bottom-aligned (law 4 — the field has a label, the link does not), 12px gaps.
- **The primary is rightmost** (law 6).
- `Cancelar` is `quiet`. A flow's exit does not compete with its completion.
- The one-time code for the browser is `code` on `accent-soft`, `user-select: all`, one size step up — the one thing the user must read accurately.
- The error callout spans the full content column.
- `verifying` disables the field and the primary and swaps the label; it does not remove the controls.
- The terminal disclosure is `quiet`, closed by default, never widens the card.

## 21. Selection and secret (screens 2, 3, 5)

**Organização.** A `select` at 44px, full content width, label above. Loading renders it disabled with `Carregando organizações…`; an empty result renders a **guidance** callout, not an error — no organizations is a state, not a failure.

**Token and Chave.** A password field, label above, `Salvar e continuar` on the same baseline, right. A stored value shows its masked hint as a `meta` receipt beside the label, and the placeholder becomes `Substituir valor salvo`. The field never shows the stored value. On a successful probe, the wizard advances to the next step.

## 22. Tudo pronto (screen 6)

| Element | Spec |
|---|---|
| Card ground | `tint-good` |
| Washes | `wash-good` behind the illustration, `wash-accent` low-right. Two, inside the card, neither under text. |
| Tile | 56px, `good-soft`, 28px `good-bright` check |
| Celebration | 5 rounded confetti strokes in `good-bright`, `warn`, `info`, `accent-2`. Asymmetric. Once per flow, here only. |
| Chip | `Configuração concluída`, good tone, dot |
| Headline | `Tudo pronto para começar` in `hero` |
| Support | Two `body-soft` lines, ≤60ch |
| Primary | `Ir para projetos`, `primary-flow`, leading folder icon, trailing right-arrow |
| Illustration | The app window with checked items and the sparkle cluster, right, `aria-hidden` |
| Stepper | node 6 active (`Pronto`); no `Continuar` in the footer |

**This is the one screen where the copy may speak about the product** rather than the next action — it is the only screen with nothing left to do.

## 23. Motion in the flow

**One authored moment: the step advance.** Incoming body rises 8px and fades in — `step-in`, `ease-out`. The stepper node state updates with the step index. No page-load choreography.

**Celebration on screen 6 only:** confetti scales from `0.96`, 40ms stagger, once, under 500ms, never looping. Removed under `prefers-reduced-motion`, which keeps the fade.

## 24. Responsive

**≥1100px** — two-column body inside the shell.
**720–1100px** — shell full width; panel stays when space allows.
**<720px** — stepper labels hidden (nodes remain); benefits stack to one column; **illustration panel removed, not shrunk**; controls stack; `Voltar` and `Continuar` share the footer width.

---

# Part III — The app screens

## 25. App shell

Every screen, onboarding included, lives in one shell that fills the window, the way the night-workspace reference does (§3.10).

```text
  ╭──╮  ╭──────────────────────────────────────────────────────╮
  │▦ │  │ ⌂ Projetos › customer-api › create-customer          │
  │──│  │ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
  │▢ │  │ │ panel        │ │ panel        │ │ panel        │   │
  │▥ │  │ │ scrolls      │ │ scrolls      │ │ scrolls      │   │
  │  │  │ │ on its own   │ │ on its own   │ │ on its own   │   │
  │☀☾▣│  │ └──────────────┘ └──────────────┘ └──────────────┘   │
  ╰──╯  ╰──────────────────────────────────────────────────────╯
```

| Region | Spec |
|---|---|
| Shell | Full window height (`100dvh`), 16px around, the rail on the left and an empty column of the same width on the right, so the content is always exactly centered in the window; the whole shell is at most 1760px wide. The page itself never scrolls. |
| Rail | A rounded glass pill (`surface`, `line` border, lit rim but no top glint, because a straight glint floats off its round top), vertically centered. From top: the product mark (a `gradient-primary` tile with the grid glyph, links to `/`, named `Teams AI, início`), a hairline, then one 44px icon button per destination, in this order — `Projetos` (folder), `Custos` (coin), `Chat de dúvidas` (speech bubble) and `Configurações` (gear) — then the theme control stacked vertically (§3.10). The current destination has an `accent-soft` ground, `accent-ink` glyph, a small dot beside it and `aria-current="page"`. Every icon carries an `aria-label` and a `title`. The rail shows icons only: no visible words. |
| Content area | Holds the current screen and scrolls inside. It has no background, border or edge of its own: the screen sits straight on the page gradient, and only the cards carry edges. |
| Workspace | A screen with more than one panel uses the shared Workspace: from 1024px up the panels sit side by side, fill the window height and each scrolls on its own; below 1024px a tab bar shows one panel at a time, and hidden panels stay mounted so typed text survives. Panels can share a group: between 1024px and 1280px the refinement stacks Revisão and Verificação in one right column at full height with a single scroll, so neither is squeezed to half the window. |
| Below 768px | The rail becomes a bottom bar across the window and the frame loses its border and radius, so the content gets the whole width. |
| Breadcrumb | §11.14, first line of the frame, no rule beneath unless a screen has no panels |
| Page title | **None** where the breadcrumb names the thing |
| Document title | Every route sets the browser tab title to the destination name followed by `· Teams AI`. |
| Skip link and focus | The first focus stop is `Pular para o conteúdo`, which moves focus to the content area. Each route change starts the content at its top, with focus on it. |

The rail holds destinations only; the breadcrumb still carries the path inside a project.

## 26. Refinement — `/refine/:projectId/:specId`

Three panels. Widths from the reference, expressed as a grid:

```
grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 0.95fr)
```

The document panel is widest because it holds the editor; the other two are near-equal. `align-items: start` — panels size to their content and do not stretch to match the tallest.

### 26.1 Documentos do projeto

| Element | Spec |
|---|---|
| Tile | `accent-soft` / `accent`, `file-text` glyph |
| Overline | `Área de trabalho` |
| Title | `Documentos do projeto` |
| Chip | `Editável` — accent tone, `pencil` icon. When the spec is locked: `Somente leitura`, neutral tone, `lock` icon. |
| Tabs | §11.7 — `project.md` `briefing.md` `stack.md` `flow.md`, filenames in `ui`, no truncation (they are short and fixed) |
| Editor | §11.8, capped at ~60vh with its own scroll |
| Footer | §11.13 — `info` + `As alterações são salvas automaticamente ao sair do editor.` only; no action, since `Avaliar` moved to §26.2 |

**The editor is a textarea, not a code editor**, and must not pretend otherwise: no syntax highlighting, no autocomplete, no bracket matching. The gutter and the mono face are there so a spec's structure is scannable, not to imply an IDE the product does not have.

The save explanation is a **statement of system behavior**, so it is `meta` with an `info` icon — never a callout, which would imply the user must act.

### 26.2 Área de revisão

| Element | Spec |
|---|---|
| Tile | `violet-soft` / `violet`, `clipboard` glyph |
| Overline | `Refinamento` |
| Title | `Área de revisão` |
| Chip | `N em aberto` — `warn` tone with a `clock` icon when N > 0, `good` tone with a dot when N = 0 |
| Actions | One row above the guidance callout: `Avaliar`/`Reavaliar` as `primary` with a leading check icon (disabled while evaluating or started; asks for confirmation when nothing changed) |
| Guidance | §11.5 guidance callout, `lightbulb` icon, bold `Próximo passo:` lead-in |
| Questions | `body-soft` when empty: `Nenhuma pergunta em aberto.` Otherwise a list of question cards. |
| History | §11.9 section header `HISTÓRICO` with a `clock` icon, then the inline empty state or the entries |

**The chip's tone tracks the count, and `0 em aberto` in warn tone is wrong** — zero open questions is a good state, not a caution. The reference shows warn at zero; the system corrects it. This is the same class of defect as §3.9's tone-from-container rule: state must drive tone.

### 26.3 Lista de verificação

| Element | Spec |
|---|---|
| Tile | `good-soft` / `good`, `shield` glyph |
| Overline | `Controle de qualidade` |
| Title | `Lista de verificação` |
| Chip | `Atual` good with a dot · `Desatualizada` warn with a dot when the spec changed after the last analysis |
| PO / SM | §11.6 fields with a leading `user` icon, `label` above, 16px apart |
| Files | §11.9 header `ARQUIVOS GERADOS` with a `file-text` icon, then §11.10 rows |
| Tasks | §11.9 header `TAREFAS` with a `list` icon, then the sectional empty state |
| Secrets | §11.9 header `SEGREDOS` with a `lock` icon |
| Meta | §11.12 — `N etapas · N tokens · US$ N.NN` |
| Last evaluation | Last row of the Meta block, `Última avaliação`: the duration of the last evaluation as `45 s` or `2 min 5 s`; `—` before any, `em andamento` while it runs |
| Action | `Iniciar análise`, primary, full width, leading `play` glyph with its +1px optical nudge |

`Iniciar análise` is full width because it is the panel's whole purpose and nothing in that panel competes with it (§11.3).

**While an analysis runs**, the button enters `loading` with the label `Analisando…`, the chip becomes `Em andamento` accent, and the tasks section swaps its empty state for skeleton rows. The meta line updates live with `polite` announcement, and its tabular figures keep the separators from shifting.

### 26.4 Responsive

**≥1280px** — three columns as above.
**1024–1279px** — two columns: the documents beside a right column that stacks Revisão and Verificação (§25).
**Below 1024px** — one panel at a time behind the tab bar (§25). The editor keeps its cap; the tab strip scrolls horizontally if it ever exceeds the width.
**<720px** — 24px gutter; panel padding 20px; `radius-lg`; editor gutter narrows to 36px; file rows keep their download button at 32px with a 44px hit area.

**Each panel scrolls its own body with its header pinned** — never the whole column, and never the page behind a fixed panel.

### 26.5 New project: document stages

A new project shows its five documents as stages, in this order: `flow.md`, `project.md`, `briefing.md`, `stack.md`, `design.md`. For a new project the stages replace the tabs of §26.1. A spec, a continued spec and an imported backlog keep the tabs.

| Element | Spec |
|---|---|
| Stage steps | An ordered list above the editor, labelled `Etapas dos documentos`. Each step shows its number, its file name in `ui`, and its state as text: `Feito`, `Atual` or `Pendente`. The current step has `aria-current="step"`. A step whose document changed after its note, or whose earlier document changed after the step was done, also shows `desatualizado`; the notice names the earlier document. State is never colour alone (§30.5). |
| Confidentiality | A row above the editor until the owner answers: `Projeto confidencial?` with `Sim, é confidencial` and `Não é confidencial`. Until an answer, no document goes to the Jev and no score is taken. |
| Attach | `Anexar arquivo` above the editor. The file is read as text and replaces the document, after the owner confirms when the document holds text. A file that cannot be read leaves the document as it was. |
| Not applicable | `Não se aplica` above the editor of `design.md` only. After the same confirmation as Attach, it writes one sentence that says the project has no interface, adds the document to the Graphify graph and ends its stage at once. Reprocess keeps that sentence and lets the agents improve its text, never the template; the Jev counts a part marked not applicable as present. |
| Decisions | The `## Decisões` section of the briefing stays when a save or an attach leaves it out, so an answered question is never lost by an edit. |
| Alignment | A line under the editor: `Alinhado com os outros documentos.`, or `Não alinhado com os outros documentos:` followed by the divergences. It is the last stage review's result for this document against the documents before it; before any stage review, it is the last full round's contradictions check. |
| Stage actions | One row below the editor: `Voltar` (secondary, disabled on the first stage or while a run is on), `Avaliar esta etapa` (secondary, disabled while a run is on or the stage has used its rounds), `Continuar` (primary). After the last stage, `Continuar` becomes `Quebrar o backlog`. |

`Avaliar esta etapa` reviews only the current stage's document. The earlier documents are context only, and no other document changes. The stage's rounds count against `TEAMS_AI_REFINE_MAX_ROUNDS` from the stage's first round.

### 26.6 Checklist de validação do documento

Aparece no painel `REVISÃO DA ETAPA`, entre o cartão do Jev e os avisos. Cinco linhas, cada uma com um marcador (ponto ou check) e um texto:

| Linha | Passa quando |
|---|---|
| `Revisado depois da última edição` | a revisão da etapa é posterior à última edição do documento |
| `Sem pergunta obrigatória aberta` | nenhuma pergunta obrigatória da etapa está sem resposta |
| `Sem sugestão pendente` | nenhuma sugestão da etapa espera aceitar ou rejeitar |
| `Formato do modelo` | o texto tem a forma do modelo do documento (e `flow.md` é Mermaid) |
| `No Graphify` | o documento está no grafo do Graphify depois da última edição |

Enquanto o grafo trabalha, a última linha mostra um spinner e o botão `Continuar` lê `Adicionando ao Graphify…`. Depois, lê `No Graphify: n nós`. Se a extração falhou, a linha diz o motivo em palavras simples, e `Continuar` tenta de novo.

`Continuar` fica desligado enquanto qualquer linha falha. A dica ligada ao botão nomeia a primeira linha que falta. Estados: tudo passa; uma linha falha; o grafo trabalha; o grafo falhou; editado depois da etapa (a linha `No Graphify` fica pendente e o texto da etapa vira `desatualizado`).

### 26.7 Etapa de arquitetura

Uma etapa do assistente entre `Revisão` e `Backlog`. A tela principal é um cartão com cabeçalho, uma frase e uma linha de estado.

| Elemento | Especificação |
|---|---|
| `Estilo` | `Monólito` ou `Microsserviços`, a razão e o documento e a seção em que a decisão se apoia. |
| `Repositórios (n)` | linhas recolhíveis, como as dos épicos do backlog: nome, chip do tipo (`api`, `jobs`, `web`, `mobile`, `workflow`, ou `Monólito`), contagem de integrações. Aberta, mostra a responsabilidade e a citação. Com mais de 12 repositórios, filtro e paginação como nas specs. |
| `Integrações (n)` | linhas `consumidor → provedor · contrato`. |
| `Perguntas da arquitetura` | os cartões de pergunta já usados no refinamento; uma pergunta bloqueante segura o backlog. |
| Ações | `Voltar` (secundária), `Redefinir` (secundária), `Quebrar o backlog por repositório` (primária, sempre habilitada). Ao clicar, a etapa confere a decisão: sem decisão, mostra o motivo ao lado do botão e não avança; com os documentos mudados depois dela, grava as respostas do dono e decide a arquitetura de novo antes de criar o backlog. Sem dono no documento de projeto, o clique usa o dono configurado ou a conta GitHub conectada; sem conta conectada, o clique mostra o motivo e não avança. |
| Trava | Nenhuma. A etapa só identifica o estilo (monólito ou microsserviços) e a interface de cada repositório (web, mobile, API). Não mostra aviso de documento mudado. |

Estados: não decidida (vazio, com a única ação primária `Decidir a arquitetura`); decidindo (bloco de processo igual ao da preparação dos planos, com o título `Decidindo a arquitetura`, o `Tempo` e o que a decisão lê); decidida; falhou (motivo em palavras simples, a lista `O que ainda não fecha:` com cada regra que ficou aberta, e a ação `Decidir a arquitetura`); decisão de documentos mudados (a tela não mostra aviso nem trava; o clique em `Quebrar o backlog por repositório` mostra `Os documentos mudaram: decida a arquitetura de novo.` e não avança); com perguntas abertas.

Rótulos aprovados: `-jobs` aparece como `Workers`, `-workflow` como `Workflow`, e um único repositório como `Monólito`.

### 26.8 Backlog por repositório

Quando algum item tem repositório, o passo `Backlog` agrupa as linhas pelo repositório, e não pelo épico. Cada grupo é um título com o nome do repositório, o chip do tipo e a contagem de itens. Dentro dele, cada spec mostra o épico como etiqueta, a prioridade, as marcas de spec, plano e tarefas, e a dependência. `Cobertura` continua e ganha a contagem por repositório. A linha de planos e tarefas é a existente (`n de m etapas`). O botão primário `Iniciar desenvolvimento` abre o diálogo de resumo. A etapa só gera specs, planos e tarefas: não valida os arquivos e não mostra aviso de documento mudado no topo. O motivo que impede iniciar aparece logo abaixo de `Cobertura`. Não há alerta de itens reprovados: os agentes resolvem sozinhos os que podem resolver, uma vez por resumo, ao abrir o backlog detalhado. Eles aceitam os ajustes seguros dos documentos, reavaliam, decidem a arquitetura de novo quando ela está velha e preparam os planos e tarefas que faltam. O rodapé fica só com os botões. Quando `Preparar de novo` reaproveita todos os planos, porque nada mudou, a etapa diz `Os planos já estavam atuais; nada foi refeito.` logo abaixo do estado dos planos.

### 26.8.1 Cobertura: chips que abrem a lista

Os chips de `Cobertura` são botões. Cada um mostra a lista do que conta, logo abaixo da linha de chips, e a árvore por épico continua abaixo do painel. Um clique abre o painel daquele chip; clicar no mesmo chip de novo fecha; clicar em outro troca a lista. O chip aberto tem a borda de destaque e `aria-pressed` verdadeiro. Sem chip escolhido, o painel não aparece.

- `seções`: o título de cada seção do `flow.md` e a quantidade de itens que a cobrem.
- `spec`: o código da spec, o título do item e o épico.
- `critério`: o código do critério com o texto dado, quando e então, e as tarefas que o cobrem.
- `tarefa`: o código da tarefa, o título e o critério que ela cobre.
- `lacunas`: não abre painel. As lacunas continuam em vermelho logo abaixo, como hoje.

No celular, o painel ocupa a largura toda e os chips quebram em linhas. Usa só os tokens e componentes da tela de refinamento, sem cor nova.

### 26.9 Diálogo de resumo do refinamento

É o `Dialog` existente, com título `Resumo do refinamento`. Traz:
- sete linhas de verificação, cada uma com marcador e texto, na ordem das checagens de fechamento;
- uma tabela compacta, uma linha por repositório, com as colunas specs, planos e tarefas;
- um recolhível `Premissas assumidas (n)` com a lista;
- uma frase sobre o que o desenvolvimento autônomo faz: até duas specs ao mesmo tempo, reparos e novas tentativas, custo só como alerta;
- `Cancelar` (secundária) e `Autorizo iniciar o desenvolvimento` (primária).

Uma verificação que falha só alerta: a primária continua habilitada. O diálogo lista cada verificação com o seu detalhe, e a etapa Backlog não mostra alerta: os agentes resolvem os itens reprovados sozinhos (§26.8). O servidor recusa só um resumo diferente do que a página mostra (409), nunca por causa de uma verificação reprovada. Abaixo de 720 px, o diálogo vira uma folha em largura total. O botão primário só fica habilitado com o resumo que a página mostra; o servidor recusa um resumo diferente com 409.

### 27.2 Projeto: repositórios

No lugar do painel `Serviços` da página do projeto, depois de `Execuções`, um painel `Repositórios (n)`, com o cabeçalho de seção (ícone, título, dica), busca e filtro pelo tipo. A grade de cartões tem 1, 2 ou 3 colunas conforme a largura do contêiner. Cada cartão mostra o nome como link, o chip do tipo, a responsabilidade (no máximo duas linhas), `n specs · n planos · n tarefas`, `Tarefas: n de m concluídas` com uma barra determinada, um chip de estado com o ponto e a contagem de bloqueios, e o botão discreto `Abrir painel`.

`Especificações` continua para as specs sem repositório (grupo `Sem repositório definido`) e mantém `Nova spec`. Projetos sem arquitetura mantêm o painel `Serviços` como está.

### 27.3 Painel do repositório

Rota `/projects/:projectId/:repoId`. Um monólito usa o nome do projeto como `repoId`. Uma página só, rolável, com a atividade real dos agentes no repositório. Atualiza sozinha a cada 5 segundos, enquanto a aba está visível.

- Migalha `Projetos › <projeto> › <repositório>`.
- Cabeçalho com o nome, o chip do tipo, o chip de estado, a responsabilidade e os atalhos.
- Botões conforme o tipo, sempre visíveis: API e Workers mostram `Abrir Swagger`; Web mostra `Abrir aplicação`; Monólito mostra os dois. O botão abre o endereço do último deploy verificado quando a sonda confirma o caminho. Quando não pode abrir, fica desabilitado com o motivo em palavras: `sem dados` antes de qualquer deploy, `sistema desligado`, `o plano não declara a documentação da API`, `a documentação não responde`, `a aplicação não responde na raiz` ou `a porta do serviço não está publicada`. Com o sistema desligado, aparece também o botão `Iniciar`.
- Sete cartões, na mesma fileira: `Tarefas` (total, com concluídas, pendentes e em execução); `Runs` (total, com em andamento); `Falhas` (runs e tarefas com falha); `Bloqueios` (tarefas, perguntas, segredos e paradas do programa); `Entregas` (tarefas entregues, com specs entregues e aguardando validação); `Progresso geral` (tarefas entregues sobre o total, com barra determinada); `Custo` (soma do custo em US$ das runs do repositório, com o número de runs). Desktop: sete colunas. Entre 768 px e 1279 px: quatro e três. Celular de 390 px: duas colunas, com `Custo` ocupando a linha inteira.
- `Entregas por spec`: as specs agrupadas por estado, nesta ordem: `Aguarda validação`, `Falhou`, `Bloqueado`, `Em desenvolvimento`, `Pendente`, `Não iniciado`, `Entregue`. Grupo vazio não aparece. Cada linha mostra a spec, a prioridade, o chip de estado e `n de m tarefas`. Uma linha expande as suas tarefas, com estado, tentativas, motivo, pull request e `Abrir run`, que leva a `/runs/:runId?task=<id>`.
- Classificação da tarefa: `Falhou` é a tarefa parada pela própria causa, sem decisão pendente. `Bloqueada` é a tarefa que espera uma dependência ou uma decisão do dono. Uma run pausada aparece em `Bloqueios`, não como tarefa bloqueada.
- `Atividade por agente`: uma linha por papel que atuou, com o nome que a run já usa para ele. Cada linha mostra etapas com sucesso e falha, tarefas criadas, iniciadas e concluídas, arquivos alterados, testes que passaram e falharam, custo e última atividade. Papel sem atividade não aparece.
- `Runs`: tabela no padrão de §11.16, com run, tipo, estado, início, tarefas mescladas e custo. Uma linha abre `/runs/:runId`.
- `Falhas e bloqueios`: só aparece com item. Cada item traz o motivo e, quando há uma run ou tarefa, o link `Abrir run`, que leva à decisão pendente.
- `Integrações`, com as linhas da arquitetura que tocam o repositório.
- `Linha do tempo`: os eventos de todas as runs da spec, em frase, com agente, hora, resultado (ponto `good` ou `bad`) e link para a run. Mostra até 200 eventos, paginados de 10 em 10 como a tabela de runs, com o aviso do total. Recolhível, aberta por padrão.
- `Aguardando dependências`: só aparece com item. Lista as tarefas que esperam outra spec ou tarefa terminar, com o que falta.
- A tabela de `Especificações` fica abaixo do board, num bloco recolhível (§27.3.1).
- Em telas estreitas, os cartões ficam em duas colunas e as tabelas viram cartões (§11.16).
- Premissas: `Entregas` e `Progresso` contam tarefas. Run parada pelo dono não é falha. O cartão de tarefas do repositório na página do projeto usa a mesma contagem.

Dado que a fonte não existe mostra `sem dados`, nunca um número.

#### 27.3.1 Tabela de especificações (recolhível)

Bloco recolhível, fechado por padrão, abaixo do board de entregas. Colunas: spec, prioridade, estado, plano, tarefas `n de m`, depende de. Em telas estreitas, a tabela rola na horizontal dentro do seu painel. Filtro, paginação e a abertura das tarefas de cada linha ainda não estão implementados.

### 26.10 Etapa de arquitetura: aviso de documentos

Aparece só numa sessão de repositório de documentos cujo backlog ainda não foi ativado. Em sessões legadas a etapa fica como está.

| Elemento | Especificação |
|---|---|
| Aviso | Cartão no topo da etapa `Arquitetura`, acima do título. Ícone `file`, tom `accent` (fundo `accent-soft`, borda `accent-line`). |
| Título | `Documentos` |
| Texto | `Cria o repositório privado <dono>/<nome> e publica os documentos. Apagar o projeto aqui não apaga o repositório.` |
| Nome | O destino do repositório (`docsTarget`): o dono do GitHub do projeto e, no monólito, o nome do projeto; nos microsserviços, `artefacty`. Vem do estado da sessão. |
| Sincronização | Abaixo do aviso, o estado da publicação (estados abaixo): uma linha com a contagem enquanto há alterações esperando, ou o motivo da falha em palavras simples. Sem nada, não aparece. |
| Botão | `Quebrar o backlog por repositório` (primário, como hoje). Numa sessão de repositório de documentos com o backlog desligado, chama a ativação do backlog, que cria o repositório. Com o backlog ligado, ou numa sessão legada, só navega para `Backlog`. |

Wireframe (aprovado com o texto e a posição pelo dono):

```
┌ Arquitetura ───────────────────────────────────────────────┐
│ [file]       Documentos                                    │
│              Cria o repositório privado dono/nome e        │
│              publica os documentos. Apagar o projeto aqui  │
│              não apaga o repositório.                      │
│              (linha de sincronização, se houver)           │
├────────────────────────────────────────────────────────────┤
│ Arquitetura                                                │
│ Decida se o sistema é um monólito ou microsserviços …      │
│ [cartão da decisão]                                        │
│                                 [Quebrar o backlog por …]  │
└────────────────────────────────────────────────────────────┘
```

Estados do aviso:
- Mostrado: sessão de repositório de documentos, backlog desligado, destino conhecido.
- Oculto: sessão legada; backlog já ligado; destino ainda sem dono conhecido (o aviso não mostra um nome incompleto).

Estados da linha de sincronização (`DocsSyncNotice`):
- Ausente: nada é mostrado (sessão sem sincronização).
- Pendente: uma linha com a contagem de alterações esperando a publicação.
- Falhou: o motivo em palavras simples, sem código.
- Em dia: nada é mostrado.

Regra do botão: a ação da etapa é a mesma da etapa `Backlog`, sem uma segunda rota. O dono vê o aviso antes de clicar, então o botão não cria um repositório sem aviso.

### 26.11 Etapa Resumo

A última etapa do assistente, antes de `Arquitetura` ou `Backlog`. Na tela e no assistente chama-se `Resumo`; o endereço continua `?etapa=revisao`. A etapa só mostra o estado do refinamento: não avalia, não processa e não edita documento. Para mudar algo, o dono volta à etapa do documento e processa lá.

| Elemento | Especificação |
|---|---|
| Cabeçalho | Overline `Etapa final`, título `Resumo`, frase `Veja as notas, as pendências e o que foi verificado. Para mudar algo, volte à etapa do documento.` |
| Notas do Jev | Bloco `Notas do Jev` com a nota de cada documento, e a ação `Validar com o Jev` (secundária, largura total). Projeto confidencial: `Projeto confidencial: o Jev não lê os documentos.` |
| Graphify | Uma linha por documento: `no Graphify` ou `fora do Graphify`; a linha fora do grafo tem `Adicionar ao Graphify`. |
| Pendências | Recolhida por padrão. O cabeçalho tem `Pendências` e o botão secundário `Mostrar pendências (N)`, com N o total de pendências dos documentos. Aberta, o botão vira `Ocultar pendências` e cada documento vira um link `documento: n pendências`, que abre a etapa desse documento. |
| Perguntas sem documento | Sempre visíveis, fora da lista recolhida, com o cartão para responder. Responder não edita documento. |
| Lista de verificação | O painel da §26.3, sem mudança: PO, SM, consumo de IA, arquivos gerados e segredos. Mostra o motivo de cada item que falta para iniciar. |
| Ações | `Voltar` (secundária) e `Continuar` (primária). Sem `Avaliar tudo`. |

Wireframe (aprovado pelo dono com as escolhas abaixo):

```
Etapa final
Resumo
Veja as notas, as pendências e o que foi verificado. Para mudar algo, volte à etapa do documento.

┌ Notas do Jev ─────────────────────┐  ┌ Lista de verificação ─────┐
│ flow.md 26% · project.md 42% …    │  │ Produto (PO) ▸            │
│ [ Validar com o Jev ]             │  │ Técnico (SM) ▸            │
└───────────────────────────────────┘  │ Consumo de IA             │
┌ Graphify ─────────────────────────┐  │ Arquivos gerados          │
│ flow.md: no Graphify …            │  │ Segredos                  │
└───────────────────────────────────┘  └───────────────────────────┘
┌ Pendências  [ Mostrar pendências (N) ] ──┐
└──────────────────────────────────────────┘
                       [ Voltar ]  [ Continuar ]
```

Escolhas do dono:
- Pendências recolhidas por padrão: o resumo não mostra a lista sem clique.
- Perguntas sem documento continuam respondíveis no resumo.
- Só o nome muda; o endereço `?etapa=revisao` fica, para os links salvos e os testes.

### 26.11.1 Validação automática do specs.md (aprovado pelo dono)

Acontece na etapa `Backlog`, depois da `Arquitetura`, porque o `specs.md` sai do backlog e o backlog só existe depois da arquitetura. Ao abrir a etapa, o sistema grava `specs.md` a partir do backlog pronto, confirma a gravação lendo o arquivo de volta e pede a análise de PO e SM. Nenhum botão dispara isso. A `Lista de verificação` da etapa Backlog mostra o bloco `specs.md` acima de PO e SM. O `Resumo` não mostra PO, SM nem o `specs.md`. A análise roda de novo a cada abertura da etapa enquanto PO ou SM estiver reprovado ou com falha.

| Elemento | Estados |
|---|---|
| Arquivo `specs.md` | `Gerando` · `Gerado` · `Falhou` |
| PO e SM | `Pendente` · `Analisando` · `Aprovado` · `Reprovado` · `Falhou` |
| Reprovado | cada motivo em uma linha, abaixo do nome do revisor |
| Falhou | uma frase com o motivo; roda de novo na próxima abertura |
| Última validação | `Última validação: dd/mm hh:mm`, uma linha |
| Ação `Continuar` | habilitada só com o arquivo gerado e PO e SM aprovados; desabilitada até lá, com a razão ao lado: `Falta a aprovação do SM` ou `Aguardando a análise do PO` |

Não há botão `Gerar specs.md`.

Wireframe proposto:

```
┌ Lista de verificação ──────────────────────────┐
│ Consumo de IA   20 chamadas · US$ 0,05         │
│ ┌ specs.md ────────────────────────────────┐   │
│ │ Gerado · 14 itens                        │   │
│ │ Produto (PO)   Aprovado     dd/mm hh:mm  │   │
│ │ Técnico (SM)   Reprovado    dd/mm hh:mm  │   │
│ │   · AC-003 não cobre o objetivo Saúde    │   │
│ └──────────────────────────────────────────┘   │
│ Produto (PO) ▸    Técnico (SM) ▸               │
│ Arquivos gerados  ·  Segredos                  │
└────────────────────────────────────────────────┘
          [ Voltar ]  [ Continuar ]  Falta a aprovação do SM
```

Escolhas do dono: o botão `Gerar specs.md` sai de vez; `Continuar` fica visível e desabilitado com a razão, em vez de sumir.

## 27. Projects, Run, Status

Not yet pinned by a reference. Until one exists, they inherit Part I and §25 without invention:

- **Projects** — breadcrumb `⌂ › Projetos`, one panel per project or a table (§11.16) where the count exceeds a screen. The actions of a project card (`Excluir`, `Nova spec`, `Graphify`, `Abrir`) stand one under the other in a single column of full-width buttons, at every screen width. Empty state per §11.11, sectional form.
- **Run** — breadcrumb `⌂ › Projetos › <project> › <run>`, a phase timeline using chips (§11.4), a task list using rows (§11.10), the terminal (§11.15), and the meta line (§11.12) for tokens and cost. The existing `.phase`, `.test` and `.status-pill` classes all collapse into the one chip family.
- **Blocked run: the owner's question** — when a block asks the owner, the banner's "Próximo passo" row holds a radio group (the shared `OptionGroup`, as in the refinement questions: one option tagged "Recomendada", and "Outra resposta…" with a text box) and one primary button, "Decidir e continuar". Reprocessar is secondary while a question is open. The question comes from the Scrum Master's `block-options` step, which runs only when the owner decides blocks (the switch is No) and asks for two to four choices the repository can carry out. Its rules live in the step's pack and in the Scrum Master's agent file.
- **Project hub** (`/projects/:projectId`) — section headings are H2. Services are a grid of links to their repositories: one column on a phone, up to eight on a wide screen. The specs are one list in groups by who must act next: `Precisam de você`, `Em andamento`, `Prontas`, `Concluídas`; a group with no spec is left out. While a backlog runs, the specs card leaves out the `planejada` rows, because the panel "Specs do backlog" lists them; the running or interrupted spec stays with its `Abrir execução` button, and with no backlog running the planned rows show as before. Each row has one primary action. The new spec form uses the app's own fields and buttons: a padded textarea, a 40px input, `Cancelar` as the secondary action and the primary action at the right.
- **Info buttons** — a section or counter whose meaning is not obvious carries the app's `InfoTip` after its title, with one or two plain sentences; a title that says everything gets none. The project hub explains its counters (executions, in progress, total cost), runs, documents, repositories and the decisions panel; the repository page explains agent activity, deliveries per spec, failures, blockers and runs.
- **Link buttons** — the label of a `.link-button` is centered, also when the button grows to the minimum button width.
- **Status** — a single panel, no breadcrumb beyond `⌂ › Status`.

**Nothing on these screens invents a component.** If one of them needs a shape this document does not describe, that shape is added here first.

### 27.1 Backlog execution — section `#execucao` of `/projects/:projectId`

**One place for the execution.** The project hub follows a running backlog on its own page: right under the counters, the section `Execução do backlog` (anchor `#execucao`) holds the panel "Specs do backlog" and the decision timeline. The decision timeline appears only once a decision was answered; asks where a model failed or the Jev key is missing are a warning chip `N consultas sem resposta` (with a tip naming the Jev and the model key); an unsure answer below the confidence bar is not counted at the right of the status line, shown only above zero, and there is no empty state. There is no separate status card on the hub: the panel header carries the status line (spinner, or alert icon when interrupted, "Executando o backlog · N de M concluídas", "· 1 aguarda sua validação" or "· 2 aguardam sua validação" for the specs awaiting validation, cost) and the progress bar under it, and the spec running now shows its phase under its run id. A spec awaiting validation does not hold the backlog: its dependents start at once, and only the owner's validation completes it. When nothing runs and only such specs are left, the status line reads "Aguardando sua validação · N de M concluídas" with a clock icon in place of the spinner. There is no separate screen and no button that leads to one. The old address `/refine/:projectId/:specId/program` redirects (replace) to `/projects/:projectId#execucao`, so saved links still work. The refinement page of a started spec shows the same status card with the link `Acompanhar no projeto`, which goes to the hub.

**Where each action leads.** Starting an execution (from the refinement or from the hub) always lands on `/projects/:projectId`. The refinement receives the owner only when the owner opens it. A run opens at `/runs/:runId`; its breadcrumb is `⌂ › Projetos › <project> › <spec> › <run>`, and the validation adds `› Validação`. `Projetos` is always `/projects`, the project is always `/projects/:projectId`, the run is a link on the validation page; the spec is plain text because a concluded spec has no refinement to open.

Same parts as the refinement card, nothing new. The panel "Specs do backlog" has its title at the left and the status line at the right; the status card (spinner, clock or check, "Executando o backlog · N de M concluídas" or "Aguardando sua validação · N de M concluídas", the progress bar, one line per spec running now with "Acompanhar a run") stays only on the refinement page of a started spec. A run that lost its process (the owner's Stop, or a crash) reads as interrupted: the status line says "Backlog interrompido" with an alert icon in place of the spinner once every spec running now is in that state. Its list pill is the hub's "interrompida" pill. Each spec is one row on fixed columns — rank, title with its run id and, while it runs, its phase under it, the hub's status pill, then the action (`Executar agora`, `Tentar de novo`, or the `prioritária` chip), and the cost last, right-aligned at the end of the row, so every row's cost lines up on the same edge. A live row has a faint `accent-soft` ground. Below 1024px status, cost and action wrap under the title.

### 27.4 Run — cabeçalho com atividade ao vivo

A linha de progresso do cabeçalho do run ganha, enquanto um agente trabalha, um trecho em `accent-text` com o papel, o que ele faz, a tarefa (se houver) e o tempo decorrido. O tempo conta a cada segundo.

- Um agente: `Desenvolvimento implementando a tarefa T0-scaffold há 1 min 12 s`, com o papel de `ROLE_LABEL` e o verbo de `STEP_DOING`.
- Vários agentes: `3 agentes trabalhando, o mais antigo há 1 min 12 s`.
- Nenhum agente aberto, ou a run fora de `em execução` e `finalizando`: o trecho não aparece.

Ordem da linha: tarefas mescladas · em andamento · bloqueadas · **atividade** · etapas · custo. Quebra como o restante da linha (abaixo de 768px, uma coluna). Etapas e custo continuam subindo só quando a etapa termina, e o texto não promete custo parcial.

```
[barra ████████░░░░░░░░░░]  0 de 4 tarefas mescladas · 1 em andamento · Desenvolvimento implementando a tarefa T0-scaffold há 1 min 12 s · 23 etapas · US$ 0.0961
```

### 27.6 Validação e volta para o agente

- A entrega só se valida quando a run termina sem tarefa bloqueada. Com tarefa bloqueada, "Concluir especificação" e "Relatar problema" ficam desabilitados e a nota diz quantas tarefas estão bloqueadas.
- "Abrir aplicação" aparece só quando o serviço responde com página web (ou é front). "Abrir Swagger" aparece só quando o caminho de documentação declarado no plano responde com sucesso.
- A run que terminou com tarefa bloqueada mostra "Enviar para o agente corrigir". Reinicia só as tarefas bloqueadas; o que já foi mesclado fica. Com "Autorizo os agentes a tomar decisões: Sim", a run volta sozinha ao agente até 3 vezes antes de parar.

### 27.5 Excluir projeto

Diálogo `ConfirmDialog`, o mesmo da exclusão de rascunho, em dois passos. Ação destrutiva e irreversível, então o verbo vai no botão e nunca há "OK".

- **Passo 1, só quando o projeto tem repositório no GitHub.** Título "Excluir projeto?", nome do projeto em `confirm-subject`, depois "Repositórios no GitHub" com a lista `owner/name` de cada repositório (projeto e serviços). Checkbox "Apagar também no GitHub", desmarcado por padrão. Botão "Continuar". Sem repositório no GitHub, o passo 1 some e a exclusão começa no passo 2.
- **Passo 2, confirmação.** Título "Confirmar exclusão". Resumo: specs, execuções e arquivos locais; com o checkbox marcado, "N repositórios no GitHub" e a lista; "Execuções em andamento são paradas"; "Não pode ser desfeito". Campo para digitar o nome do projeto, exigido sempre: o botão "Excluir projeto" fica desabilitado até o texto bater com o nome. Botões: ✕ (cancelar, foco inicial) e "Excluir projeto".
- **Aviso antes de começar.** No passo 2, em bloco próprio logo abaixo do resumo, com borda e cor de perigo: "Depois que a exclusão começar, não tem como cancelar."
- **Repositórios.** No passo 1, o título "Repositórios no GitHub (N)" com a contagem. No passo 2, "Também serão apagados no GitHub (N)" com a lista quando o checkbox está marcado, e "Os repositórios no GitHub não serão apagados." quando não está. O ícone do passo 1 é a lixeira, porque a etapa já trata de exclusão.
- **Em background.** Ao confirmar, o diálogo fecha e a exclusão roda em background. O botão Excluir do cartão mostra um spinner no lugar do ícone e fica com `aria-disabled` (sem perder o foco); "Abrir" e "Nova spec" desse cartão ficam inativos até a exclusão terminar. Ao fechar ou confirmar, o foco volta ao botão Excluir do cartão. A página mostra "O projeto <id> está sendo excluído em background." enquanto a exclusão roda. A exclusão segue no servidor mesmo se a página for fechada. O servidor guarda quais projetos estão sendo excluídos (`GET /api/project-deletions`), então ao recarregar a página o spinner e o aviso voltam, e um segundo DELETE do mesmo projeto responde 409.
- **Erro na exclusão.** Falha do servidor aparece na página, em `role="alert"`, com o id do projeto e o motivo (por exemplo, o repositório que falhou no GitHub e o comando `gh auth refresh -h github.com -s delete_repo`). O spinner some e o projeto continua na lista.
- **Erro ao listar repositórios.** Aparece dentro do diálogo, e a exclusão segue só com os arquivos locais.
- **Carregando.** Enquanto a lista de repositórios chega, o passo 1 mostra "Carregando repositórios…" no lugar da lista; o botão "Continuar" fica desabilitado.
- Sem visual novo: o diálogo, os botões e os tons são os de §11.3 e do `ConfirmDialog` atual.

### 27.7 Repositório — tabela de tarefas

Um cartão `Tarefas (N)` logo abaixo dos indicadores e antes de "Entregas por spec". Ele lista todas as tarefas do repositório, uma linha por tarefa, sem agrupar por spec.

- **Linha.** Título da tarefa em negrito, com a spec e o responsável em texto de apoio abaixo; à direita, o chip de estado (§11.4) e, só para tarefa que não terminou com sucesso (bloqueada ou falhou), o botão `Detalhe`. Abaixo de 768px a linha vira uma coluna.
- **Filtro.** Caixa de busca por título, tarefa ou spec, e um filtro de status com os estados da tela de entregas (`Entregue`, `Em desenvolvimento`, `Pendente`, `Bloqueada`, `Falhou`). Sem o filtro, o contador mostra só o total.
- **Paginação.** A mesma paginação das outras tabelas do repositório (`Itens por página`, o intervalo `1–10 de 16` e as setas anterior e próxima), feita no servidor. Trocar o filtro ou a busca volta para a primeira página.
- **Detalhe.** Abre um diálogo (§11.3) com o título da tarefa, três dados (`Tarefa`, `Spec`, `O que aconteceu`), o problema e a solução em linguagem simples, e o texto técnico do revisor dobrado em "Ver detalhe técnico". O mesmo bloco aparece na tela da run, então o texto é igual nos dois lugares. Link `Abrir run` no rodapé do diálogo.
- **Vazio.** "Nenhuma tarefa encontrada." quando o filtro não acha nada.

```
┌ Tarefas (16) ─────────────── [busca] [Status: todos ▾] ┐
│ Criar rota /ping                       ● Entregue      │
│ spec-02 · Desenvolvimento                              │
│ Validar login                          ● Falhou  [Detalhe]
│ spec-02 · Desenvolvimento                              │
│  Itens por página [10 ▾]     1–10 de 16     ← →      │
└────────────────────────────────────────────────────────┘
```

## 28. Copy

Brazilian Portuguese, sentence case, short, action-oriented. Technical detail stays inside disclosures. Controls name their action; errors name the problem **and** the recovery. System behavior is stated, not requested.

Already right, stays verbatim: `Configure este ambiente` · `Tudo pronto para começar` · `Documentos do projeto` · `Área de revisão` · `Lista de verificação` · `As alterações são salvas automaticamente ao sair do editor.` · `Nenhuma tarefa gerada ainda.` · `As tarefas aparecerão aqui após a análise.` · `Login cancelado. Você pode tentar novamente.`

**Proposed changes — these alter shipped product copy and need approval:**

| Current | Proposed | Why |
|---|---|---|
| kicker `Configuração local` | *(removed)* | An eyebrow above a page title adds nothing the title does not carry. |
| `Login do GitHub CLI` | `GitHub CLI` + headline `Conecte o GitHub CLI` | The screen title is the thing; the action is on the button. |
| `Login do Claude` | `Claude` + headline `Conecte sua conta do Claude` | Same. |
| `Chave do OpenRouter (Jev)` | `Chave do OpenRouter` | The parenthetical is internal vocabulary. |
| `GitHub ainda não está conectado` | *(removed — state is on the tile and chip)* | Restates two other elements. |
| `Acesse sua conta do Claude de forma rápida e segura.` | `Abra o link e cole o código que a página mostrar.` | Describe the next action, not the product. |
| `Nenhum registro no momento.` | `Nenhuma revisão registrada ainda.` | Name what is absent, not the absence. |
| `Nenhuma pergunta em aberto.` | keep | Already names the thing. |
| — | `Disponível após conectar o GitHub` | New: locked screens must explain themselves. |
| — | `Nenhuma organização encontrada para esta conta.` as guidance, not error | A state, not a failure. |

## 29. Definition of done

1. One breadcrumb, no page title where the breadcrumb names the thing, no global nav.
2. Every panel uses the §11.2 header; tile, overline, title and chip align across side-by-side panels.
3. No gradient outside the onboarding flow. One gradient object per onboarding screen.
4. One primary per panel; one per screen where the screen is a single unit.
5. Chip tone tracks state — including `0 em aberto`, which is good, not warn.
6. Tile hue encodes domain and never changes with state.
7. Tab changes do not animate.
8. Every control implements all seven states in §12.
9. Every icon renders a 1.5px stroke at its display size.
10. No shadow on a chip, input, row, tab or editor — only panels are raised.
11. No popover clipped by a scrolling panel; each panel scrolls its own body with its header pinned.
12. Contrast verified on both gradient ends, the violet tile and the warn ground.
13. At 1600px, 1200px, 900px and 390px: no horizontal overflow with a 64-character code, a 40-character spec name and a 200-character editor line.
14. `prefers-reduced-motion` removes travel and celebration, keeps state and the progress fill.
15. Zero color, size, shadow or radius literals outside the token layer.
16. The §16 review checklist answered with evidence.

---

## 30. Refinement workspace reference

The user-provided reference images 2 and 3 are the approved visual target for `/refine/:projectId/:specId`. Image 1 is rejected as an implementation target because it is visually sparse, lacks the workspace hierarchy, and does not establish the three-panel composition.

### 30.1 Composition

- Use one light workspace page with a single breadcrumb: home icon, `Projetos`, project id, and spec id/status.
- Use three equal visual columns at desktop widths: `Documentos do projeto`, `Área de revisão`, and `Lista de verificação`.
- Keep a 16px column gap, 16–20px panel radius, subtle panel border, and one soft panel shadow. The page background is the existing cool light surface.
- Collapse to two columns at medium widths and one column on small screens. Never create horizontal page overflow.
- Each panel header follows the standard tile + eyebrow + title + status chip alignment.

### 30.2 Documents panel

- Use the blue document tile, `Área de trabalho` eyebrow, `Documentos do projeto` title, and `Editável` state chip.
- Keep the five document tabs visible with horizontal scrolling when necessary: `project.md`, `briefing.md`, `stack.md`, `flow.md`, and `design.md`. A new project shows the same five documents as stages, in the order of §26.5, in place of the tabs.
- The editor is a quiet bordered surface with readable monospace text, line-number treatment when available, and a copy affordance in the upper-right corner.
- Keep the automatic-save hint below the editor. The `Avaliar`/`Reavaliar` action moved to the review panel's actions row (§30.3) and keeps the approved blue-violet action treatment.

### 30.3 Review panel

- Use the purple clipboard tile, `Refinamento` eyebrow, `Área de revisão` title, and `0 em aberto` state chip.
- Show the actions row (`Avaliar`/`Reavaliar`) immediately below the header, then the next-step callout with a lightbulb icon and short, actionable Portuguese copy.
- Empty review state copy is `Nenhuma pergunta em aberto.`. The history section uses a clock icon and an explicit empty state rather than a blank box.
- Questions, answers, patches, and rejection controls remain functional; the reference styling must not hide or remove them.

### 30.4 Quality panel

- Use the green shield tile, `Controle de qualidade` eyebrow, `Lista de verificação` title, and `Atual` state chip.
- PO and SM are review-agent roles, not user-entered fields. Show them as clearly labeled checklist groups; do not ask the user to enter agent names.
- Generated files use bordered rows with a chevron/summary affordance and download action. Tasks use a bordered empty state with `Nenhuma tarefa gerada ainda.` and `As tarefas aparecerão aqui após a análise.`.
- A red `Documentos sem contradições` item lists each verified divergence beneath it: the fact, the document and section of both quotes, and the fix. The item is red only when the orchestrator finds both quotes in the documents.
- Keep the secrets and token summary at the bottom. `Iniciar análise` is the panel's primary action and occupies the full available width.
- Surface the current analysis cost immediately below the quality-panel header in a highlighted summary: steps, tokens, and USD cost. Cost visibility is part of the primary workspace hierarchy, not a footer detail.
- Render secrets as compact key/value rows with an `Adicionar segredo` action. Accept any valid uppercase environment-style key, support multiple rows, never echo stored values, and keep saving controls aligned with the panel grid.

### 30.5 Interaction and accessibility

- All labels, empty states, errors, and actions are Brazilian Portuguese, concise, and recovery-oriented.
- Preserve keyboard focus, visible focus rings, native button semantics, and accessible labels for icon-only controls.
- Status colors communicate state but never stand alone; every status also has text.
- Use the existing spacing, control-height, border, color, and typography tokens. Do not introduce one-off visual literals outside the token layer.

### 30.6 Jev role in refinement

Jev findings are advisory. Its document consistency checks must be recorded in the refinement journal and passed to Claude, PO, and SM as review context. A low-confidence or negative Jev finding may create guidance, but it must not create `CycleFailed`, fail a checklist item, prevent derivation, disable `Reavaliar`, or require a document edit before the next cycle; it is only noted in the item's detail.

A stage review (§26.5) scores only its own document, and it scores nothing until the owner has answered the confidentiality question. A stage review that fails records its reason and changes nothing.

**Decision on availability.** A full round needs the Jev when the project is not confidential. When the Jev does not answer, the round fails with `Jev indisponível: confira a chave do OpenRouter.` before any agent runs (`server/refine/cycle.ts:306-309`, tested in `test/refine/cycle.test.ts`), and the page says the evaluation does not continue without it. A stage review (§26.5) does not need the Jev: when the Jev does not answer, the review goes on, and the score line says the Jev did not answer.

### 30.7 Backlog step cards

A etapa Backlog tem quatro cartões em largura total, na ordem: `Precisa de você`, `Itens do backlog`, `Planos de implementação` e `Verificação`. O cabeçalho de cada um cabe em uma linha: tile de ícone, título com `InfoTip`, quem preenche (PO, SM ou Dev), chip de estado e chevron.

Só o cartão em foco abre sozinho e ganha borda de acento: o primeiro que ainda depende de algo, nesta ordem: o que espera o dono, backlog sem detalhe, planos não atuais, `specs.md` sem aprovação. Um cartão com pergunta aberta também abre. Os outros ficam recolhidos e o dono abre à mão.

O título interno do conteúdo não se repete: a contagem de specs vai no chip do cartão do backlog. Abaixo de 720 px os cartões continuam empilhados, sem mudar de ordem.

A lista de specs por repositório não fica solta no cartão do backlog: ela abre ao clicar no chip `specs` da `Cobertura`, e o mesmo clique a fecha.

## 31. Pedido em projeto em desenvolvimento (aprovada pelo dono e implementada)

Estado: proposta. Nenhuma tela desta seção foi implementada. A aprovação do dono vem antes do código: é a regra de frontend do projeto.

### 31.1 Hub: formulário "Nova spec"

Mesmo lugar e aparência de hoje, sem a etapa de ID. Texto livre e o botão "Começar refinamento". Com um pedido já aberto, o formulário é trocado por um aviso que nomeia o pedido e leva a ele.

```
Especificações (i)                                      [ Nova spec + ]
┌────────────────────────────────────────────────────────────────────┐
│ Descreva o que adicionar ou mudar                                  │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Ex.: o administrador precisa exportar o relatório mensal em PDF│ │
│ └────────────────────────────────────────────────────────────────┘ │
│ Os agentes leem os documentos e as specs, medem o impacto e         │
│ replanejam. Você só responde o que eles não decidirem sozinhos.     │
│                        [ Cancelar ]  [ Começar refinamento → ]      │
└────────────────────────────────────────────────────────────────────┘
```

### 31.2 Tela do pedido

Trilha de etapas (Pedido · Impacto · Specs e plano · Pronto) e cartões no mesmo padrão do `StepCard`. Os cartões existentes do backlog (Precisa de você, Itens do backlog, Planos e Verificação) continuam. Os novos são Pedido, Impacto e Replanejamento.

```
⌂ › Projetos › meu-projeto › pedido-2
● Pedido ── ○ Impacto ── ○ Specs e plano ── ○ Pronto
┌ Seu pedido · Escrito por você                              [ Interpretado ] ┐
│ "O administrador precisa exportar…"   salvo em briefing.md › Nova demanda    │
└───────────────────────────────────────────────────────────────────────────────┘
┌ Impacto · Analisado pelo SM                                          [ Atual ] ┐
│ [3 specs novas] [2 afetadas] [2 documentos] [1 risco]   ← chips abrem a lista   │
│ Afeta: auth-login (entregue) → ajuste proposto                                  │
│ Conflito: export-csv ↔ report-pdf (mesmo módulo) → ordem definida               │
│ Documentos atualizados (acréscimos): flow.md › Exportação               [ ver ] │
└───────────────────────────────────────────────────────────────────────────────┘
┌ Replanejamento · Montado pelo PO                                  [ 4 mudaram ] ┐
│  #  spec            estado      novo #   mudança                                 │
│  1  auth-login      entregue    1        mantida                                 │
│  4  report-pdf      nova        2        nova                                    │
│  2  export-csv      planejada   3        desceu 1 · depende de …                 │
└───────────────────────────────────────────────────────────────────────────────┘
Pronto: ✓ specs validadas  ✓ impacto  ✓ planos e tarefas 14/14  ✓ sem pergunta aberta
        Trilha: Pedido → 3 specs → 3 planos → 14 tarefas     [ Iniciar desenvolvimento ]
```

### 31.3 Responsivo

Abaixo de 720 px os cartões empilham na mesma ordem, os chips quebram linha e a tabela de replanejamento vira uma linha por spec, como as linhas de `ProgramStatus`. Não há rolagem horizontal da página.

### 31.4 Tela enxuta: o time faz tudo e o dono só inicia

Objetivo: os agentes refinam sozinhos e deixam tudo pronto; o dono só clica em "Iniciar desenvolvimento" quando o refinamento automático termina.

- Sempre visíveis: "Seu pedido", o bloco "Pronto" com o botão e, só quando algo espera o dono, "Precisa de você" acima do "Pronto".
- Impacto, Replanejamento, Itens do backlog, Planos e Verificação ficam recolhidos num único bloco "Detalhes do time". Nada é apagado.
- Clicar numa etapa da trilha abre os detalhes antes de rolar até o cartão.
- O selo da Verificação mostra quantos itens falharam ("2 itens falharam"), não só "Pendente".
- "Precisa de você" só aparece na frente depois que o time parou com algo que não conseguiu decidir (o servidor registra a parada e os motivos). Enquanto o time trabalha, ou quando nada sobrou, o cartão fica dentro de "Detalhes do time" e o motivo aparece no estado do topo.
- O refinamento é enxuto só no pedido de continuação que o time faz sozinho: ele avalia uma vez, aplica as correções dos revisores e dá as verificações por resolvidas, sem reavaliar, a menos que sobre uma falha que uma conferência simples, sem agente, ainda aponte. Só os itens ainda não iniciados recebem plano e o impacto roda junto com as specs. A meta é deixar o pedido pronto para desenvolver em até 5 minutos, com teto de 10.
- O specs.md é conferido por uma checagem simples, sem agente (critério repetido, tarefa que cita critério inexistente, critério sem tarefa). O PO e o SM o revisam em paralelo com o preparo dos planos; se apontarem problemas, o motivo aparece em "Verificação" e o desenvolvimento não fica bloqueado.
- Um item já iniciado ou entregue nunca recebe o pedido novo como fonte: por isso o pedido novo não gera ajustes falsos nas specs que ele não toca.
- Quando sugestões esperam o dono, "Precisa de você" oferece duas saídas: decidir uma por uma (o botão "Mostrar pendências" leva a cada documento, onde cada sugestão tem Aceitar e Rejeitar) ou "Aceitar todas (N)" de uma vez. Aceitar todas põe as sugestões nos documentos e chama os agentes de novo, que conferem e preparam só o que mudou, sem reavaliar tudo. O botão fica desativado enquanto o time trabalha.
- Se o time parou sem nada para o dono decidir (a sessão do Claude expirou, a preparação dos planos falhou, um passo deu erro), o topo diz o motivo e o botão "Tentar de novo" ocupa o lugar de "Iniciar desenvolvimento".
- O time aceita sozinho acréscimos em qualquer documento e reescritas que não mudam o escopo. Só mudança de escopo e aprovação de ajuste chegam ao dono.
- O endereço `?etapa=<documento>` abre esse documento dentro da tela do pedido, com o botão Voltar para a tela do pedido.

```
● Pedido ── ● Impacto ── ● Specs e plano ── ○ Pronto
┌ Seu pedido · Escrito por você                              [ Interpretado ] ┐
└───────────────────────────────────────────────────────────────────────────────┘
┌ Precisa de você (só se houver)                                [ 2 em aberto ] ┐
│ Decida uma por uma, abaixo, ou aceite todas de uma vez: …                     │
│ [ Aceitar todas (2) ]   [ Mostrar pendências (2) ]                            │
└───────────────────────────────────────────────────────────────────────────────┘
Pronto: ✓ impacto  ⏱ falta: planos e tarefas 0/1                [ Iniciar desenvolvimento ]
▸ Detalhes do time   impacto, replanejamento, backlog, planos e verificação
```

## 32. Nova spec em modal

Todo botão "Nova spec" (card do projeto, página do projeto, chat e execução concluída) abre o mesmo modal grande, na própria tela, sem levar à página do projeto.

### 32.1 Composição

- Usa o `Dialog` em tamanho grande: 56 rem de largura no máximo e 90% da altura da janela.
- Cabeçalho com o título `Nova spec · <projeto>` e o botão de fechar.
- Corpo com um rótulo, uma caixa de texto alta (pelo menos 14 rem), uma frase que diz o que os agentes farão e, quando houver, o erro.
- Rodapé com `Cancelar` (secundário) e `Criar spec` (primário, com seta), alinhados à direita.

### 32.2 Comportamento

- `Criar spec` fica desativado com o campo vazio e mostra o estado de envio sem permitir um segundo clique.
- Ao confirmar, a tela abre `/refine/<projeto>/<spec>`, onde os agentes organizam a spec no padrão das outras.
- Um erro aparece dentro do modal e o texto digitado é mantido.
- Fechar com texto digitado pede confirmação antes de descartar.
- O formulário sempre aparece, mesmo com um pedido ainda em refinamento. Nesse caso uma nota diz "Os agentes ainda trabalham em <spec>. Você pode criar esta spec agora: ela entra na fila e o refinamento começa sozinho quando eles terminarem."
- O pedido novo é criado na hora e abre com o estado "Seu pedido está na fila", sem gastar nenhuma chamada. Quando o time do pedido anterior para, o refinamento dele começa sozinho. Limite conhecido: o pedido seguinte parte dos documentos que o anterior já refinou, ainda que o dono não tenha decidido o anterior.

### 32.3 Responsivo

Abaixo de 640 px o modal ocupa a tela toda e os botões empilham, com `Criar spec` em cima.

### 32.4 Botão "Sugestão"

- Botão secundário com lâmpada, ao lado de `Criar spec`. Fica desativado com o campo vazio, durante o envio e durante a própria sugestão ("Sugerindo…").
- Ao clicar, o servidor consulta o grafo do projeto (Graphify), que reúne o código, os cinco documentos e as specs, planos e tarefas já existentes. Ele só consulta, não valida: vê o que já existe e devolve o texto reescrito em detalhe. O texto substitui o do campo para o usuário revisar; nada é criado até clicar em `Criar spec`.
- Um erro aparece dentro do modal e o texto digitado é mantido.

## 33. Custos — `/costs` e `/costs/:projectId`

Modo: **Operate.** A pessoa quer saber quanto foi gasto, onde, e qual agente gastou mais, sem interpretar gráfico. Todo número vem dos registros do sistema. O que não tem fonte diz que não tem.

### 33.1 Decisões de produto

- Refinamento e Desenvolvimento são sempre dois blocos, cada um com total próprio. Nenhum total mistura as duas etapas sem mostrar as duas partes.
- Valor em dólar americano (`US$`), estimado a preços de API. A tela nunca diz que o valor foi cobrado: no plano de assinatura o custo não é cobrado por uso.
- Período: `Hoje` (dia corrente no fuso do servidor), `7 dias`, `30 dias` e `Tudo`. Padrão: `Tudo`.
- Sem gráfico de linha, pizza ou rosca. Participação é barra horizontal com o valor escrito ao lado.
- Custo é alerta, nunca parada: a tela não tem ação que limite gasto.

### 33.2 Visão global — `/costs`

```text
┌────┬──────────────────────────────────────────────────────────────────┐
│ ◆  │ Custos                                           [ Atualizar ]   │
│ ── │ Quanto cada projeto gastou, onde e com qual agente.              │
│ ▤  │ ( Hoje ) ( 7 dias ) ( 30 dias ) ( Tudo )                         │
│ $  │ ┌ Total ───────┐┌ Refinamento ┐┌ Desenvolvimento ┐┌ Chat ──────┐ │
│ ▢  │ │ US$ 39,6700  ││ US$ 6,1000  ││ US$ 33,2000     ││ US$ 0,1200 │ │
│ ⚙  │ │ 5,7 mi tokens││ 15%         ││ 84%             ││ 1%         │ │
│ ☾  │ └──────────────┘└─────────────┘└─────────────────┘└────────────┘ │
│    │ ┌ Por projeto ───────────────────────────────────────────────┐   │
│    │ │ Projeto  Refinamento  Desenvolvimento  Chat  Total  Execuç.│   │
│    │ │ kayron…  US$ 3,1000   US$ 20,1000      0,0500  23,2500 31  │   │
│    │ │          ▇▇▇          ▇▇▇▇▇▇▇▇▇▇▇▇                         │   │
│    │ └────────────────────────────────────────────────────────────┘   │
│    │ ┌ Por agente ──────────────────┐┌ Por modelo ───────────────┐     │
│    │ │ Refinamento · po US$ 2,0000 ▇▇││ opus   US$ 30,0000▇▇▇▇▇▇▇│     │
│    │ │ Desenvolv. · dev US$ 15,0000▇▇││ sonnet US$  8,0000 ▇▇    │     │
│    │ └──────────────────────────────┘└───────────────────────────┘     │
│    │ Jev fora de projetos: US$ 0,4000 (i)  2 journals não lidos (i)   │
└────┴──────────────────────────────────────────────────────────────────┘
```

Ordem de cima para baixo: cabeçalho com título, uma linha de apoio e `Atualizar` (secundário, à direita); chips de período; faixa de quatro indicadores (Total, Refinamento, Desenvolvimento, Chat); painel `Por projeto`, uma linha por projeto, clicável, que abre `/costs/:projectId`; dois painéis lado a lado, `Por agente` e `Por modelo`; rodapé com `Jev fora de projetos` e os avisos de leitura.

### 33.3 Visão do projeto — `/costs/:projectId`

```text
Projetos › kayron-hub › Custos          Atualizado às 10:42  [ Atualizar ]
( Hoje ) ( 7 dias ) ( 30 dias ) ( Tudo )
┌ Total ┐ ┌ Refinamento ┐ ┌ Desenvolvimento ┐ ┌ Chat ┐
┌─ Refinamento ───────────────────┐ ┌─ Desenvolvimento ─────────────────┐
│ US$ 3,1000 · 18 steps        (i)│ │ US$ 20,1000 · 212 steps        (i)│
│ Por agente  po ▇▇ sm ▇ front ▇  │ │ Por agente  dev ▇▇▇▇ test ▇▇ sec ▇│
│ Por modelo  …                   │ │ Por modelo  …                     │
│ Por tipo    docs ▇ spec ▇ plano │ │ Por fase    Tarefas ▇▇▇ Plano ▇ … │
│ Por modelo  Sonnet 5.5 · Haiku  │ │ Por repositório  api ▇▇ web ▇     │
└─────────────────────────────────┘ └───────────────────────────────────┘
┌─ Por spec ────────────────────────────────────────────────────────────┐
│ Spec    Refinamento   Desenvolvimento   Total   Execuções             │
└───────────────────────────────────────────────────────────────────────┘
┌─ Steps ── Etapa [Todas ▾] Agente [Todos ▾] Spec [Todas ▾]  [busca] ───┐
│ Data  Etapa  Spec  Run  Repo  Tarefa  Agente  Fase  Modelo  Tokens US$│
│                                                      < 1 2 3 … >     │
└───────────────────────────────────────────────────────────────────────┘
Chat: US$ 0,1200 · 14 respostas
```

Dois painéis lado a lado, cada um com o próprio total e a própria lista. Abaixo, `Por spec` (uma linha por spec com as duas colunas de custo), a tabela paginada de `Steps` com filtros e busca, e a linha de Chat.

### 33.4 Componentes

- **Painel:** cabeçalho de §11.2 (ícone em bloco, rótulo pequeno, título e um chip de estado).
- **Indicador:** faixa auto-ajustável de §11.2, com valor grande e uma linha de apoio. Os indicadores de etapa e de chat trazem a barra de participação logo abaixo da linha de apoio.
- **Títulos de painel:** todo painel de custos tem um botão de informação ao lado do título, com o texto de §33.6. O conteúdo do painel começa no topo (`content-start`), sem espaço extra acima quando ele divide a linha com outro painel.
- **Barra de participação:** rótulo à esquerda, trilho de 6 px (§11.17), preenchimento `accent` liso, valor e percentual escritos à direita. A etapa vem sempre escrita ao lado da barra: a cor nunca é a única pista.
- **Chips de período:** família única de chips (§3.9). Selecionado: `accent-soft` com texto `accent-ink` e `aria-pressed="true"`. Os chips quebram linha; não há rolagem horizontal.
- **Tabelas:** §11.16. Números à direita, em algarismos tabulares. Abaixo de 44 rem viram cartões (`responsiveTable`).
- **Carregamento:** esqueleto de §11.2 do tamanho do painel; aparece só após 300 ms.
- **Atualização:** a cada 30 s, somente com a aba visível. Ao lado de `Atualizar`, o texto `Atualizado às HH:MM` mostra a última leitura boa.

### 33.5 Estados

| Estado | Texto ou visual |
|---|---|
| Sem custo no período | `Nenhum custo registrado neste período.`, com a linha `O custo aparece aqui depois que um refinamento ou um run chamar um modelo.` Os percentuais viram `Sem custo no período`. |
| Erro de leitura | `Não foi possível ler os custos. Tente de novo.` com o botão `Tentar de novo`. O último valor lido continua visível. |
| Journal que não pôde ser lido | Chip de aviso `N registros não lidos`, com ajuda: o total pode estar abaixo do real. |
| Jev fora de projetos em período curto | `Indisponível neste período`. |
| Chat sem registro de custo | Ajuda: respostas que falharam não têm custo registrado. |
| Escalonamentos antigos sem custo | Linha abaixo do rodapé: `N chamadas de escalonamento para o Claude em execuções antigas, sem custo registrado. Elas não entram no total.` Some quando não há mais nenhuma. |

### 33.6 Ajuda (botões de informação)

- **Total:** `Soma de refinamento, desenvolvimento e chat. Valores estimados a preços de API. No plano de assinatura, o custo não aparece cobrado.`
- **Refinamento:** `Custo dos agentes e do Jev que refinaram documentos e specs, antes do desenvolvimento.`
- **Desenvolvimento:** `Custo dos agentes que implementam, testam, revisam e publicam as specs, inclusive decisões automáticas.`
- **Escalonamento para Claude:** `Decisões que o Claude tomou quando o Jev não bastou. O papel que pediu a decisão não fica registrado.`
- **Retomada:** `Em runs retomados, o total pode ser diferente do custo da tabela de runs.`
- **Jev fora de projetos:** `Custo do Jev que não pode ser ligado a um projeto, como validações de documentos de projetos apagados.`

### 33.7 Formato

- Dinheiro: `US$ 39,6700` (vírgula decimal, pt-BR, sempre quatro casas decimais, sempre com `US$` antes do valor). O mesmo formato vale em todas as telas e na API, que arredonda a quatro casas.
- Tokens: forma compacta pt-BR (`5,7 mi tokens`).
- Percentual sem casas decimais, com `%`.
- Frases curtas, em sentença normal, sem jargão de sistema.

### 33.8 Responsivo

- Acima de 1024 px: os painéis lado a lado.
- De 768 a 1023 px: um painel por linha.
- Abaixo de 768 px: barra inferior do §25; indicadores em duas colunas; a lista de specs e a tabela de steps somem da tela e uma frase explica que aparecem no computador. Os totais e os agrupamentos continuam. Nenhuma rolagem horizontal da página, nem em 360 px.

### 33.9 Acessibilidade

- Foco visível em chips, linhas clicáveis e botões.
- Cada barra tem o valor escrito; cada tabela tem cabeçalhos `th`.
- A linha inteira do projeto abre `/costs/:projectId`; o nome do projeto é o link, e a linha inteira é a área de clique.

### 33.10 Fora desta tela

Limite de gasto, mudança de comportamento dos runs, série temporal, exportação.

## 34. Configurações — modelos por agente, chat, graphify e automático

Tela `/settings`, dentro do que já existe. Nenhuma forma nova de tela: as linhas seguem o padrão da lista de agentes.

### 34.1 Modelos e esforço, por projeto

A seção `Modelos e esforço` lista os oito papéis e mais duas linhas, `Chat` e `Graphify`, nesta ordem. Os papéis mantêm `Automático` e `Manual`. `Chat` e `Graphify` têm modelo e esforço fixos: não há `Automático`. O esforço de `Graphify` vai ao graphify pela variável `CLAUDE_CODE_EFFORT_LEVEL`. O cabeçalho da seção conta todas as linhas, por exemplo `10 manuais · 10 agentes`.

### 34.2 Modelos automáticos, globais

Um bloco `Modelos automáticos` fica entre `Configurações por Projetos` e `Configuração Global do Ambiente`. Ele mostra cinco escolhas, usadas pelos papéis em `Automático` em todos os projetos deste computador:

| Linha | Usada em |
|---|---|
| Tarefa pequena | tarefa de tamanho pequeno no modo de roteamento |
| Tarefa média | tarefa de tamanho médio |
| Tarefa grande | tarefa de tamanho grande |
| Arquitetura | passos de tech-spec, plano, services-plan e arquitetura |
| Refinamento, ciclos seguintes | passos de refinamento a partir do segundo ciclo |

Cada linha tem um modelo e um esforço. O esforço de cada linha vale como escolhido, em qualquer modelo, como no modo manual. O padrão de cada linha é Baixo. Cada escolha salva ao mudar. Se o salvamento falha, a escolha volta à anterior e aparece a mensagem de erro.

O limite de esforço por modelo continua valendo só para a escolha do decider do Jev, quando ele responde. Nesse caso, Haiku e Opus ficam em Baixo e Sonnet vai até Alto.

```
Modelos automáticos                                    (i)
Usados pelos papéis em Automático, em todos os projetos.
Tarefa pequena                  [ Haiku 5.5  v ]  [ Baixo  v ]
Tarefa média                    [ Sonnet 5.5 v ]  [ Baixo  v ]
Tarefa grande                   [ Sonnet 5.5 v ]  [ Baixo  v ]
Arquitetura                     [ Opus 5.5   v ]  [ Baixo  v ]
Refinamento, ciclos seguintes   [ Sonnet 5.5 v ]  [ Baixo  v ]
```

### 34.3 Fora desta tela

A escolha de modelo das decisões do Jev (`decisions.modelTiers`) não entra aqui. Ela segue a configuração do arquivo.

## 35. Chat — linha de uso de cada resposta

- A linha abaixo de cada resposta do assistente mostra, nesta ordem: custo estimado, tokens lidos, tokens escritos, número de buscas na web e tempo.
- As buscas aparecem como `1 busca na web` ou `N buscas na web`, com `0 buscas na web` quando a resposta não pesquisou. Mensagens salvas antes desta regra não têm a contagem, e a linha as mostra sem ela.
- Depois das buscas e antes do tempo vem `N consultas ao grafo` (`1 consulta ao grafo` no singular): as vezes que a resposta consultou o grafo do projeto por conta própria. `0 consultas ao grafo` quando consultou nada. Respostas salvas antes desta regra não têm a contagem, e a linha as mostra sem ela.

## 36. Grafo do código — `/graph/:projectId`

O grafo do código tem uma tela própria por projeto. O hub do projeto não tem mais o card do grafo: só o botão `Ver grafo do código` no cabeçalho, ao lado de `Abrir no GitHub`. O cartão do projeto em `/projects` tem o mesmo atalho, `Grafo`.

- Cabeçalho: trilha `Projetos › projeto › Grafo do código`, título, `N nós · M ligações · K comunidades`, `Atualizado em` com data e hora, e o botão `Atualizar grafo`. Se a última atualização falhou, uma linha de erro diz quando e por quê, e que o grafo mostrado é o da versão anterior.
- Mapa: um canvas com os nós coloridos por comunidade. Arrastar move, a roda ou o gesto de pinça dá zoom, passar o mouse ou tocar num nó destaca as ligações dele. As comunidades são calculadas no servidor a partir das ligações, sem modelo de IA, e cada uma leva o nome do nó mais ligado.
- Lista de comunidades: ao lado do mapa no desktop, embaixo no celular. Mostra as 20 maiores com cor, nome e tamanho, e uma linha `Outras (N)` para o resto. Cada linha tem uma caixa que liga e desliga a comunidade no mapa, e `Selecionar todas` liga ou desliga todas.
- Busca: filtra os nós pelo nome. Os achados ganham um anel no mapa e entram numa lista que se usa pelo teclado.
- Nó escolhido: nome, arquivo e linha, número de ligações, comunidade, os vizinhos e `Abrir no GitHub` quando o arquivo está publicado.
- Consultas dos agentes: abaixo de `Uso pelos agentes`, a linha `Consultas feitas pelos agentes` conta as vezes que um agente rodou `graphify query`, `explain` ou `path` por conta própria, separadas por origem: `entrega N em M passos` (por tipo de passo), `refinamento N em M passos` e `chat N em M respostas`. Antes do primeiro passo medido ela diz `ainda não medido`. Com 5 passos de entrega ou mais e nenhuma consulta, uma linha avisa que nenhum agente consultou o grafo; o refinamento e o chat não disparam o aviso, porque recebem o grafo como texto e podem legitimamente consultar zero.
- Acima do mapa: a linha `Uso pelos agentes` e, quando o grafo passa de 3000 nós, o aviso de que o mapa mostra os mais ligados.
- Celular: o botão de atualizar e o do GitHub ocupam a linha inteira; o mapa tem 60% da altura da tela.
- Movimento: o desenho se organiza em poucos instantes ao abrir; com `prefers-reduced-motion` ele já aparece pronto.
- Estados: carregando, sem grafo (`Construir grafo`), erro de leitura, falha da última atualização.
