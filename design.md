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

**Applies to** every screen in `web/src`: `/onboarding`, `/projects`, `/runs/:runId`, `/refine/:projectId/:specId`, `/status`.

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
| warn | `#96620d` | `#fff4e5` | `#f2dfbd` | 4.78:1 |
| info | — | `#ddf4ff` | — | — |

Display-only greens, which never carry text: `good-bright` ≈`#22c55e` (check glyph, confetti), `good-live` `#2f9e61` (pulsing session dot). `bad-ink` `#7a2426` for body text inside a failure block.

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
| `warn` on `warn-soft` | 4.78 | pass |

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
| `warn` / `warn-soft` | `#f4b860` / `rgb(245 175 70 / 0.12)` | 7.85:1 |
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

**Dot or icon?** A dot for a state that is simply on or off — `Atual`, `Concluído`. An icon where the chip names a capability or a count — `Editável` with a pencil, `0 em aberto` with a clock. Replaces nine implementations. Tone is assigned by the element's own state class — never by an ancestor. In code the tones are `tone-good`, `tone-bad`, `tone-warn` and `tone-neutral`; `tone-neutral` is the **accent** tone and marks work in progress (`em execução`, `finalizando`).

### 11.5 Callout

One box, three variables, an optional leading icon.

Shape: 14px padding, 1px border, `radius-lg`, `body` size, 16px leading icon at 10px gap, top-aligned to the first line.

| Tone | Text | Ground | Border |
|---|---|---|---|
| error | `bad` | `bad-soft` | `bad-line` |
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
| error | border `bad` + ring in bad tone, message below in `meta` `bad` |
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
| error | `bad` border + ring, message naming problem and recovery |

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
| Rail | A rounded glass pill (`surface`, `line` border, lit rim but no top glint, because a straight glint floats off its round top), vertically centered. From top: the product mark (a `gradient-primary` tile with the grid glyph, links to `/`, named `Teams AI, início`), a hairline, then one 44px icon button per destination — `Projetos` (folder) and `Status do ambiente` (chart) — then the theme control stacked vertically (§3.10). The current destination has an `accent-soft` ground, `accent-ink` glyph, a small dot beside it and `aria-current="page"`. Every icon carries an `aria-label` and a `title`. The rail shows icons only: no visible words. |
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
| Action | `Iniciar análise`, primary, full width, leading `play` glyph with its +1px optical nudge |

`Iniciar análise` is full width because it is the panel's whole purpose and nothing in that panel competes with it (§11.3).

**While an analysis runs**, the button enters `loading` with the label `Analisando…`, the chip becomes `Em andamento` accent, and the tasks section swaps its empty state for skeleton rows. The meta line updates live with `polite` announcement, and its tabular figures keep the separators from shifting.

### 26.4 Responsive

**≥1280px** — three columns as above.
**1024–1279px** — two columns: the documents beside a right column that stacks Revisão and Verificação (§25).
**Below 1024px** — one panel at a time behind the tab bar (§25). The editor keeps its cap; the tab strip scrolls horizontally if it ever exceeds the width.
**<720px** — 24px gutter; panel padding 20px; `radius-lg`; editor gutter narrows to 36px; file rows keep their download button at 32px with a 44px hit area.

**Each panel scrolls its own body with its header pinned** — never the whole column, and never the page behind a fixed panel.

## 27. Projects, Run, Status

Not yet pinned by a reference. Until one exists, they inherit Part I and §25 without invention:

- **Projects** — breadcrumb `⌂ › Projetos`, one panel per project or a table (§11.16) where the count exceeds a screen. Empty state per §11.11, sectional form.
- **Run** — breadcrumb `⌂ › Projetos › <project> › <run>`, a phase timeline using chips (§11.4), a task list using rows (§11.10), the terminal (§11.15), and the meta line (§11.12) for tokens and cost. The existing `.phase`, `.test` and `.status-pill` classes all collapse into the one chip family.
- **Project hub** (`/projects/:projectId`) — section headings are H2. Services are a grid of links to their repositories: one column on a phone, up to eight on a wide screen. The specs are one list in groups by who must act next: `Precisam de você`, `Em andamento`, `Prontas`, `Concluídas`; a group with no spec is left out. Each row has one primary action. The new spec form uses the app's own fields and buttons: a padded textarea, a 40px input, `Cancelar` as the secondary action and the primary action at the right.
- **Status** — a single panel, no breadcrumb beyond `⌂ › Status`.

**Nothing on these screens invents a component.** If one of them needs a shape this document does not describe, that shape is added here first.

### 27.1 Backlog execution — `/refine/:projectId/:specId/program`

**Reached in two clicks:** while a backlog runs, the project hub shows its status card right under the project header, with an `Abrir a execução do backlog` button; the refinement page shows the same card. A started refinement is no longer listed under "Refinamentos em andamento", so this card is the way in.

Same parts as the hub, nothing new: the breadcrumb, a status card (spinner or check, "Executando o backlog · N de M concluídas", the progress bar, then one line per spec running now with a pulsing dot and "Acompanhar a run"), and a panel "Specs do backlog" with the count and total cost at its right. Each spec is one row on fixed columns — rank, title with its run id under it in mono, the hub's status pill, cost right-aligned, then the action (`Executar agora`, `Tentar de novo`, or the `prioritária` chip). A live row has a faint `accent-soft` ground. Below 1024px status, cost and action wrap under the title.

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
- Keep the five document tabs visible with horizontal scrolling when necessary: `project.md`, `briefing.md`, `stack.md`, `flow.md`, and `design.md`.
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

Jev is an advisory assistant, never a hard gate for derivation. Its document consistency checks must be recorded in the refinement journal and passed to Claude, PO, and SM as review context. A low-confidence or negative Jev finding may create guidance, but it must not create `CycleFailed`, fail a checklist item, prevent derivation, disable `Reavaliar`, or require a document edit before the next cycle; it is only noted in the item's detail.
