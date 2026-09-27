# Text pop-out: architecture & maintenance

Any multi-line field in the app can be opened in a large editor: a panel on a desktop, the whole screen on a phone. It exists because a `<textarea>` in a form column keeps that column's width however tall it is dragged, and the drag handle it offers is not usable on a touch screen at all. The whole feature is [`TextPopout.svelte`](../src/lib/components/ui/TextPopout.svelte), mounted once in `AppShell`, and the pure rules it runs on in [`text-popout.ts`](../src/lib/utils/text-popout.ts).

## Global, not wired per field

**No editor opts in.** The component watches `focusin` on the document, and whichever `<textarea>` takes focus is offered a button in its top-right corner. There are around thirty textareas across two dozen components, and wiring a wrapper component into each one would put this feature into every one of those files, each a merge conflict every time the file changes upstream. Watching focus keeps the footprint to one mount line, and a textarea added next month gets the pop-out without anyone remembering to give it one.

**The button appears on focus, not on hover**, because hover does not exist on a phone and a button on every field at all times would sit over the first line of everything. It is painted on `<body>` at `z-index` 310, above the dialogs (300), so a field inside a dialog still gets one, and it follows the field through scrolling and resizing (a `ResizeObserver` catches `autoResize` growing the field). On a field taller than the viewport it clamps to the top of the viewport, so the button stays in reach while the field's own top is scrolled away. `pointerdown` and `mousedown` are cancelled on it so the press does not take focus from the field, which on a phone would drop the keyboard. The field it was pressed on is remembered at `pointerdown` in case the press blurred the field anyway, and the button outlives a blur by 200 ms for the same reason.

## Writing back through the field's own events

**Every keystroke in the editor is written to the source field and announced with a bubbling `input` event** ([`writeBack`](../src/lib/utils/text-popout.ts)). That is exactly what `bind:value` and every `oninput={...}` handler already listen for, so the owning component updates its state, saves its draft and re-measures its height as though the text had been typed into the field itself. Nothing about the owner has to know the pop-out exists. The value is set before the event is dispatched, because owners read `e.target.value` inside the handler.

**Closing fires `change`, and on a phone a `blur` as well** ([`finishEdit`](../src/lib/utils/text-popout.ts)). Opening the editor moved focus off the field, so the field's real blur fired *before* any of the edits, carrying the old text. An owner that commits on blur (the assistant's custom instructions do) would never hear of the new text. On a desktop, focus goes back to the field on close with the caret where it was in the editor, and the field's own blur comes later. On a coarse pointer, focus does not go back, because it would raise the keyboard over whatever the field sits in, so a synthetic non-bubbling `blur` stands in for it. Nothing is fired when the text ends up unchanged.

**A source field that unmounts while its text is open is caught, not lost.** Edits stop being written (the element is disconnected) and the editor says so, with a copy button. The text in the editor is the only copy of those edits at that point.

## Escape belongs to the editor

**The keydown listener is registered once, at boot, on the window's capture phase**, and while the editor is open it calls `stopImmediatePropagation` on Escape and Tab. Capture listeners on the same target run in registration order, so registering at boot puts this one ahead of every Escape handler a surface adds later: `Dialog`'s window listener, Settings' capture listener, the prompt review's capture listener. Without this, one Escape in an editor opened from inside a dialog closes both. Registering on open instead would lose to any surface that registered first. Tab cycles between the editor's own controls for the same reason: the dialog underneath has its own focus trap and must not take Tab back.

## What is left out

**`data-no-popout`** on a textarea, or on any ancestor, keeps the button off it. The editor's own textarea carries it, so it cannot offer a pop-out of itself. **`TEXT_POPOUT_EXCLUDED`** lists fields left out by a class they or their parent already have, so leaving one out changes no markup upstream: the chat composer (`.composer-textarea`), a message being edited in place (`.message-content-editing`), and the Chungus Assistant's composer (`.assistant-textarea`). All are conversation text: a turn is short and sent with Enter, and an edit already sits in the widest column the app has. Disabled fields are left out. Read-only fields are not: they open as a larger, read-only view.

## Coupling

1. `TEXT_POPOUT_EXCLUDED` names classes owned by `InputArea.svelte`, `Message.svelte` and `ChungusAssistantPanel.svelte`. Renaming either class upstream silently brings the button back on those fields. The unit tests pin the list, not the markup.
2. Font family and size are copied from the source field when the editor opens, with a 16 px floor. Below 16 px, iOS zooms the page when a field takes focus.
3. `maxlength`, `readonly` and `spellcheck` are copied from the source field. Any new attribute that constrains input has to be copied here as well, or the editor will accept text the field would refuse.
