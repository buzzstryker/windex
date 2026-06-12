# Windex Chat: Typography Bump & Stacked Reactions Reference

> Documents two recent changes to the Windex chat screen so they can be replicated exactly in the Honcut app (same stack; chat originally ported from Windex). Everything below is derived from the **current source** of `windex-expo/app/(tabs)/chat.tsx` (and git history for the before-values) as of 2026-06-12 — read, not recalled. Assumes the reader has no access to the Windex repo.
>
> Relevant Windex commits, for provenance only: `d845095` (typography bump), `b852df4` (stacked reactions), `557dd9c` (Feather attach icon — incidental to this doc but touches the same composer sizes).

**Theme-dependent values are marked ⚠️ throughout** — Honcut must remap these to its own palette (dark green `#1B3A2A` / gold `#C8A96E` family), not copy them. Windex's accent is `OLIVE = '#4B5E2A'` (rgb 75, 94, 42); `colors.icon` is its secondary-text color, `colors.card`/`colors.border` its dark-mode surface/border tokens.

---

## Section 1 — Font Size Bump (+30% across the chat screen)

### 1.1 Complete before → after table

Every font size / line height that changed. All styles live in the single `StyleSheet.create` block of `chat.tsx`.

| element | style key | before | after |
|---|---|---|---|
| Message text & photo captions | `bubbleText` | `fontSize: 19, lineHeight: 25` | `fontSize: 25, lineHeight: 33` |
| Sender name labels | `authorLabel` | `fontSize: 12` | `fontSize: 16` |
| Timestamps | `time` | `fontSize: 10` | `fontSize: 13` |
| Reaction pills | `reactionPillText` | `fontSize: 18` | *(style removed — replaced by the 24pt emoji stack, §2)* |
| Composer input | `input` | `fontSize: 19` (no lineHeight) | `fontSize: 25, lineHeight: 30` |
| Send button label | `sendText` | `fontSize: 15` | `fontSize: 20` |
| Error line | `error` | `fontSize: 13` | `fontSize: 17` |
| Action-sheet title | `sheetTitle` | `fontSize: 15` | `fontSize: 20` |
| Action-sheet rows (incl. destructive) | `sheetRowText` / `sheetDestructive` | `fontSize: 16` | `fontSize: 21` |
| Sheet emoji picker glyphs | `sheetEmoji` | `fontSize: 32` | `fontSize: 42` |
| Empty state ("No messages yet…") | inline on the `<Text>` | *(none — RN default)* | `fontSize: 18` |
| Pending-photo ✕ cancel | `pendingCancelText` | `fontSize: 12` | `fontSize: 16` |
| Attach button glyph | `attachIcon` | `fontSize: 22` (📷 emoji) | *(style removed — now `<Feather name="image" size={24} />`, separate change)* |

Unchanged on purpose: caption padding (`captionPad`), bubble radius/padding, list spacing, the 10px unread-dot tab badge.

### 1.2 Proportional container changes (anti-clipping)

The larger glyphs would have clipped inside the original fixed boxes. These container values changed with the fonts and must travel together:

| container | before | after | why |
|---|---|---|---|
| Composer input | `minHeight: 40, maxHeight: 120, borderRadius: 20, paddingTop/Bottom: 10` | `minHeight: 48, maxHeight: 150, borderRadius: 24, paddingTop/Bottom: 9` | 25px text in a 40px box (20px padding) clips; 48 - 18 padding = 30px = the new `lineHeight` |
| Send button | `height: 40, borderRadius: 20` | `height: 48, borderRadius: 24` | row uses `alignItems: 'flex-end'`; controls must share height to align when the input is single-line |
| Attach button | `width: 40, height: 40` | `width: 44, height: 48` | same row alignment; centers its glyph via `alignItems`/`justifyContent: 'center'` |
| Sheet emoji circles | `width/height: 52, borderRadius: 26` | `width/height: 60, borderRadius: 30` | 42pt emoji clips in a 52px circle |

Current composer-control styles, verbatim:

```ts
input: {
  width: '100%',
  maxHeight: 150,
  minHeight: 48,
  borderWidth: StyleSheet.hairlineWidth,
  borderRadius: 24,
  paddingHorizontal: 14,
  paddingTop: 9,
  paddingBottom: 9,
  fontSize: 25, // >=16px: iOS auto-zooms on focusing an input under 16px; that
                // zoom (not any offset math) is what shoved the composer off-screen.
  lineHeight: 30,
},
send: { flexShrink: 0, borderRadius: 24, paddingHorizontal: 18, height: 48, alignItems: 'center', justifyContent: 'center' },
sendText: { color: '#FFFFFF', fontWeight: '600', fontSize: 20 },
```

### 1.3 The iOS 16px auto-zoom guard — preserve the comment

The comment on `input.fontSize` (verbatim above) is load-bearing institutional knowledge: **iOS Safari auto-zooms the page when an input with `font-size < 16px` receives focus.** In the original Windex build this zoom — not any keyboard-offset math — was what shoved the composer off-screen, and it cost a debugging session (including a temporary on-screen visualViewport overlay) to identify. At 25px the input is far above the threshold, which is exactly why the comment must survive: a future "make the input smaller" edit that drops below 16 silently reintroduces the bug. Port the comment with the style.

---

## Section 2 — iMessage-Style Stacked Reactions

### 2.1 What changed conceptually

- **Removed:** the numeric count (`{p.emoji} {p.count}` and the `reactionPillText` style are gone).
- **Added:** up to 3 overlapping copies of the emoji per pill — one per reactor — each subsequent copy peeking ~7px out from *behind* the previous (first reactor renders on top). 4+ reactions still show 3 layers.
- **Added:** an accent tint + outline on the pill containing *my* reaction, signaling "tap to remove."
- **Unchanged:** all tap/long-press behavior and the remove-confirm sheet (§2.4); the action-sheet emoji picker; the aggregation that produces `pills`.

The data shape feeding the render is unchanged: raw reaction rows aggregate to `pills: { emoji: string; count: number; mine: boolean }[]` per message — `count` is still computed and now drives the layer count instead of a label.

### 2.2 Complete current implementation, verbatim

Render block (inside `renderItem`, after the message bubble; `OLIVE = '#4B5E2A'` ⚠️, `isDark` from the color scheme, `colors` from the theme ⚠️):

```tsx
{pills.length > 0 ? (
  <View style={styles.reactionRow}>
    {pills.map((p) => {
      // iMessage-style stack: no count; one emoji per reactor,
      // each subsequent copy peeking ~7px out from BEHIND the
      // previous (zIndex descends), capped at 3 visible layers.
      const layers = Math.min(p.count, 3);
      return (
        <Pressable
          key={p.emoji}
          // Adding is one tap; removing is deliberate — tapping (or
          // long-pressing) a pill I've reacted with opens the sheet
          // directly in remove-confirm mode for that emoji.
          onPress={() => {
            if (p.mine) {
              setConfirmDelete(false);
              setConfirmRemoveEmoji(p.emoji);
              setSheetTarget(item);
            } else {
              void toggleReaction(item.id, p.emoji, false);
            }
          }}
          onLongPress={
            p.mine
              ? () => {
                  setConfirmDelete(false);
                  setConfirmRemoveEmoji(p.emoji);
                  setSheetTarget(item);
                }
              : undefined
          }
          style={[
            styles.reactionPill,
            // Olive tint + outline marks "this contains my reaction
            // — tap to remove"; others stay on the plain card/white.
            p.mine
              ? {
                  backgroundColor: isDark
                    ? 'rgba(75, 94, 42, 0.35)'
                    : 'rgba(75, 94, 42, 0.15)',
                  borderColor: OLIVE,
                }
              : {
                  backgroundColor: isDark ? colors.card : '#FFFFFF',
                  borderColor: isDark ? colors.border : '#D0D0D0',
                },
          ]}
        >
          <View style={styles.emojiStack}>
            {Array.from({ length: layers }, (_, i) => (
              <Text
                key={i}
                style={[
                  styles.stackEmoji,
                  i > 0 && styles.stackEmojiBehind,
                  { zIndex: layers - i },
                ]}
              >
                {p.emoji}
              </Text>
            ))}
          </View>
        </Pressable>
      );
    })}
  </View>
) : null}
```

Styles, verbatim:

```ts
reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2, maxWidth: '78%' },
reactionPill: {
  borderWidth: 1,
  borderRadius: 18,
  paddingHorizontal: 10,
  paddingVertical: 4,
  // Emoji glyphs can overshoot their line box; never clip at the pill edge.
  overflow: 'visible',
},
emojiStack: { flexDirection: 'row', alignItems: 'center' },
// Fixed 30px slot per 24pt emoji so the overlap step is deterministic
// regardless of glyph width; lineHeight 30 keeps tall glyphs unclipped.
stackEmoji: { fontSize: 24, lineHeight: 30, width: 30, textAlign: 'center' },
// -23 against the 30px slot = each layer peeks 7px out behind the previous.
stackEmojiBehind: { marginLeft: -23 },
```

### 2.3 Why each mechanism exists

- **`Math.min(p.count, 3)`** — hard cap of 3 visible layers regardless of actual reaction count.
- **Fixed `width: 30` + `textAlign: 'center'` per emoji** — emoji glyph widths vary by emoji and platform font; a fixed slot makes the overlap step deterministic instead of glyph-dependent.
- **`marginLeft: -23`** — against the 30px slot, each subsequent layer is displaced 7px (30 − 23), i.e. it "peeks out" 7px from behind the previous. Tune −23 (range −22…−24 for a 6–8px peek) only together with the slot width.
- **`zIndex: layers - i`** — descending, so the **first** reactor's emoji renders on top and later ones tuck behind (RN stacks later siblings on top by default; the explicit zIndex inverts that).
- **`lineHeight: 30` on a 24pt emoji** — emoji glyphs overshoot the nominal font box; 30 prevents vertical clipping.
- **`overflow: 'visible'` on the pill + `paddingHorizontal: 10, paddingVertical: 4`** — belt-and-suspenders against the rounded pill edge shaving the outermost glyph. Do not set `overflow: 'hidden'` here.
- Max pill content width is 30 + 2×7 = 44px at 3 layers — the pill stays compact.

### 2.4 Own-reaction treatment — ⚠️ theme remap required

The pill containing my reaction gets an **accent outline + translucent accent fill**; other pills stay neutral.

| | Windex value (⚠️ olive palette) | role |
|---|---|---|
| outline | `borderColor: OLIVE` (`#4B5E2A`) | accent border, `borderWidth: 1` |
| fill, light mode | `rgba(75, 94, 42, 0.15)` | subtle accent wash |
| fill, dark mode | `rgba(75, 94, 42, 0.35)` | same hue, stronger alpha so it reads against dark surfaces |
| non-mine fill | `isDark ? colors.card : '#FFFFFF'` | plain surface |
| non-mine border | `isDark ? colors.border : '#D0D0D0'` | neutral hairline |

The rgba triplet **is** the accent hex decomposed (`#4B5E2A` → 75, 94, 42) — only the alpha differs per mode. **Honcut: do not copy these.** Map to your dark-green/gold family — e.g. accent `#1B3A2A` → `rgba(27, 58, 42, 0.15)` light / `0.35` dark with a `#1B3A2A` border, or use gold `#C8A96E` → `rgba(200, 169, 110, …)` if green-on-green lacks contrast against your dark-mode surfaces. Keep the two-alpha pattern (≈0.15 light / ≈0.35 dark); that ratio is what was visually tuned. The same accent-at-0.15 also appears on Windex's sheet picker (`sheetEmojiBtnMine: { backgroundColor: 'rgba(75, 94, 42, 0.15)' }`) — remap it with the same mapping so the sheet and pills agree.

### 2.5 Tap / long-press behavior (unchanged, documented)

- **Tap a pill I have NOT reacted with** → optimistic add of my reaction (`toggleReaction(item.id, p.emoji, false)`); reverts on API failure.
- **Tap (or long-press) a pill I HAVE reacted with** → opens the long-press action sheet directly in **remove-confirm mode** for that emoji ("Remove your {emoji} reaction?" → Remove / Cancel). Removal is deliberately two-step while adding is one tap.
- **Long-press the message bubble itself** → full sheet: 5-emoji picker row (`👍 😂 🔥 ⛳ 💀` — Honcut has its own set), "Delete message" for own messages, Cancel. **This sheet is unchanged by the rework** apart from the §1 font/circle sizes.
- The `mine` flag both drives the visual treatment and gates which tap path runs — they can't drift apart.

### 2.6 What was removed

- The `{p.emoji} {p.count}` label and its `reactionPillText` style (`fontSize: 18`, pre-bump; would have been 24).
- The olive **text** treatment on own pills (`color: OLIVE, fontWeight: '600'` on the label) — superseded by the tint+outline since there's no text left to color.
- Old pill metrics `borderRadius: 16, paddingHorizontal: 12` → now `18 / 10` to suit the stack.

---

## Theme-dependent checklist (everything Honcut must remap, nothing else)

| value | where | remap to |
|---|---|---|
| `OLIVE = '#4B5E2A'` | own-pill border; (also Windex's bubble/send accent) | Honcut accent (dark green `#1B3A2A` family) |
| `rgba(75, 94, 42, 0.15)` / `0.35` | own-pill fill light/dark; sheet `sheetEmojiBtnMine` | same alphas over Honcut's accent rgb |
| `colors.card`, `colors.border`, `colors.icon` | non-mine pill surfaces; timestamps/labels | Honcut theme tokens |
| `'#FFFFFF'`, `'#D0D0D0'`, `'#E9E9EB'`, `'#1A1A1A'` | light-mode pill/bubble neutrals | Honcut light-mode neutrals (cream family) |
| `'#D32F2F'` | destructive sheet text; (Windex also uses it for the unread dot) | Honcut destructive red, if different |
| Reaction emoji set `['👍','😂','🔥','⛳','💀']` | sheet picker constant | Honcut's set (swap ⛳) |

Everything else in this document — sizes, line heights, offsets, zIndex scheme, layer cap, container heights, the 16px-zoom guard — is geometry, not palette, and should be copied as-is.
