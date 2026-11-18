// The map overlay as a modal dialog (its role, aria-modal and name, the layer
// title via aria-labelledby, are in index.template.html). Opening makes the
// page behind it inert and moves focus in; closing undoes that and returns
// focus to the control that opened it.
import { blurFocusWithin } from './focus-utils';

type State = { trigger: HTMLElement | null; inerted: Element[] };
const open = new WeakMap<HTMLElement, State>();

export function openDialog(dialog: HTMLElement, doc: Document = document): void {
  dialog.setAttribute('aria-hidden', 'false');
  if (open.has(dialog)) return; // already open: another layer, same trigger
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
  // Focus must leave the dialog before it is hidden from assistive tech (focus-utils).
  if (state?.trigger?.isConnected) state.trigger.focus({ preventScroll: true });
  else blurFocusWithin(dialog, doc);
  dialog.setAttribute('aria-hidden', 'true');
}
