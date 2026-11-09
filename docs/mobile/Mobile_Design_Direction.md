# Mobile Design Direction

**Status:** approved by the owner on 2026-11-09. Applies to the DanceFlow and DanceFlow Business mobile apps only; the web product is unchanged.
**Canvas:** [DanceFlow Mobile Design Direction](https://claude.ai/artifact/VDV3cqGVLGrPnPhoVgWywy) (private; holds the assessment, system and screen designs).
**Evidence:** real app code at `e95f52fe`, exported to web and rendered at phone size with fictional data. Native rendering and the bugs below still need confirming on a device build.

## Direction

One system, two temperaments. Both apps share tokens, components and motion rules in `mobile/shared`.

| | DanceFlow | DanceFlow Business |
|---|---|---|
| **Feel** | Engaging, expressive, personal | Polished, efficient, sophisticated |
| **Default look** | Evening dark, edge-to-edge photography | Light paper surface, plum for action only |
| **Type emphasis** | Display type for names, dates and moments | Body type leads, with aligned numerals for time and money |
| **Density** | About 3 to 5 items per screen | Dense lists, main action in thumb reach |
| **Motion** | Carries emotion | Confirms an action, then gets out of the way |

## Tokens

Existing brand tokens stay canonical: plum `#5b145e`, plum dark `#431046`, tint `#f6edf7`, surface `#fff9f3`, border `#ead9cb`, text `#2b1b2a`, muted `#6f5b6b`.

Added for mobile:

| Token | Value | Use |
|---|---|---|
| Ground | `#180C1B` | Dark background |
| Raised | `#241327` | Dark raised surface |
| Gold | `#F0B15E` | Primary action and emphasis on dark |
| Orchid | `#D69AD9` | Secondary emphasis on dark |
| Dark text | `#FBF3EE` | Text on dark |
| Dark muted | `#C4B3C3` | Secondary text on dark |
| Amber ink | `#8A5210` | Amber text on light |
| Success | `#1F6B45` | Success on light |
| Error | `#A32A1E` | Error on light |

These pairs meet 4.5:1 on their intended backgrounds. Navy, hot pink, lavender and coral are retired from the mobile apps.

## Type

- **Fonts:** Bricolage Grotesque for display, Hanken Grotesk for everything else. Bundle with `expo-font`, and confirm the licenses before bundling.
- **Scale:** 12 caption, 13 label, 15 body, 17 lead, 20 title, 28 heading, 40 display.

## Foundations

- **Spacing:** 4, 8, 12, 16, 24, 32, 48, with a 20 screen gutter.
- **Radius:** 8 controls, 12 rows, 20 cards and images, full for chips.
- **Icons:** one stroke family at 1.75.
- **Photography:** everyday adults social dancing. Competition imagery appears only inside competition features.

## Navigation

- **DanceFlow tabs:** Today, Discover, Learn, Wallet. Schedule moves into Today, and More moves to the profile button.
- **DanceFlow Business tabs:** permission-driven, for example Today, Clients, Door, More for an instructor and Pulse, Schedule, Clients, More for an owner.

## Motion

Animate transform and opacity on the UI thread with Reanimated. Replace movement with a fade when Reduce Motion is on. Timings are on the canvas.

## Accessibility

Text at 4.5:1 or better, status never by color alone, labels and roles on all controls, layouts that hold at 200% text size.

## Priorities

1. **P0:** fix unreadable text by replacing the 24 fixed-color imports with theme-aware tokens, and replace the retired logo and DF icon.
2. **P1:** build the shared token and component layer, then redesign Today, Discover, Event and Ticket. Add skeletons, distinct error states and the core motion set.
3. **P2:** add licensed or commissioned photography, refine Learn, Partners and Studio detail, and add Competition day once its backend lands.

## Not covered by this approval

- Buying or commissioning photography, which is a separate cost decision.
- The competition, ticket offline and door check-in behavior shown in the designs, which is not built.
- Native judging in v1, which stays after v1 unless the owner chooses otherwise.
