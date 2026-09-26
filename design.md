# Teams AI onboarding visual system

## Reference

The onboarding login card follows the supplied Claude authentication reference: a quiet developer setup surface with a wide white card, a warm Claude header, a blue account row, one aligned authentication control row, and a compact terminal disclosure at the bottom.

## Tokens

- Page background: `#f3f5f9`
- Card background: `#ffffff`
- Header wash: `#fff7f3` with a soft peach ambient shape
- Ink: `#182235`
- Supporting ink: `#5b6b84`
- Action blue: `#2f65e8`
- Focus blue: `#6e9cff`
- Success green: `#13814d`
- Claude mark: `#d86b47`
- Border: `#e1e8f5`

## Layout

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [Claude mark]  Login do Claude                         [Concluído]       │
│                Acesse sua conta do Claude de forma rápida e segura.      │
│                                                                          │
│ [user]  diego.silva@labsit.io (team)                                    │
│ ──────────────────────────────────────────────────────────────────────── │
│ [Abrir link]  [label + code input                         ][Enviar] [X]  │
│ ──────────────────────────────────────────────────────────────────────── │
│ [terminal] Mostrar saída do CLI                                      [⌄] │
└──────────────────────────────────────────────────────────────────────────┘
```

- The card is the primary frame; avoid additional nested cards around the whole flow.
- Header and account rows use generous vertical spacing and a clear divider before actions.
- On desktop, the link, code field, send action, and cancel action share one baseline.
- On narrow screens, the code field remains readable and actions wrap in the same order without horizontal scrolling.
- The error state occupies a full-width row below the action controls.
- Primary actions always sit in the upper-right position of their action area. They must not be stranded in the lower-left corner of a card.

## Components

- Claude mark: warm peach square with an orange radial mark.
- Status: green dot and `Concluído` for a ready account.
- Account: blue circular user icon, bold account identifier, muted team suffix.
- Primary action: vivid blue filled `Enviar` button with a paper-plane icon.
- Secondary actions: blue-tinted `Abrir link` and neutral outlined `Cancelar`.
- Terminal disclosure: dark terminal icon, plain-language label, right-aligned chevron.

## Copy rules

All onboarding copy is Brazilian Portuguese, sentence case, short, and action-oriented. Technical CLI details stay inside the expandable output; user-facing states use friendly explanations such as `Login cancelado. Você pode tentar novamente.`.

## Responsive and accessibility rules

- Preserve visible focus rings on input, links, and buttons.
- Keep touch targets at least 40px high.
- Never allow long login codes or CLI output to expand the card horizontally.
- Respect reduced-motion preferences.
