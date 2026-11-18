// A modal dialog over the page: bharatlas's map overlay and collect's photo
// viewer. Opening makes everything else in <body> inert (so Tab and screen
// readers stay inside: the focus trap) and moves focus in; closing undoes that
// and returns focus to the control that opened it. The dialog's role,
// aria-modal and name are set where it is built.

type State = { trigger: HTMLElement | null; inerted: Element[] };
const open = new WeakMap<HTMLElement, State>();

/** Open `dialog`, a child of <body>. Focus moves to it (give it tabindex="-1"), or the
 *  caller then focuses a control inside. */
export function openDialog(dialog: HTMLElement, doc: Document = document): void {
  dialog.setAttribute('aria-hidden', 'false');
  if (open.has(dialog)) return; // already open (another layer): keep the first trigger
  const active = doc.activeElement as HTMLElement | null;
  const trigger = active && active !== doc.body && !dialog.contains(active) ? active : null;
  const inerted = Array.from(doc.body.children).filter((el) => el !== dialog && !el.hasAttribute('inert'));
  for (const el of inerted) el.setAttribute('inert', '');
  open.set(dialog, { trigger, inerted });
  dialog.focus({ preventScroll: true });
}

export function closeDialog(dialog: HTMLElement, doc: Document = document): void {
  const state = open.get(dialog);
  open.delete(dialog);
  for (const el of state?.inerted ?? []) el.removeAttribute('inert');
  // Focus leaves the dialog before it is hidden: the browser blocks aria-hidden
  // on an ancestor of the focused element, hiding the control from readers.
  if (state?.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
  else if (dialog.contains(doc.activeElement)) (doc.activeElement as HTMLElement).blur();
  dialog.setAttribute('aria-hidden', 'true');
}
