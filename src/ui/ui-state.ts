// UI-wide state: dialogs, toasts, and the sidebar.

import type { ComponentChildren } from 'preact';
import { createStore } from '@/state/store';

export interface DialogEntry {
  id: number;
  render: (close: () => void) => ComponentChildren;
  /** Called when the dialog is dismissed with Back. */
  onDismiss?: () => void;
}

export const ui = createStore<{ dialogs: DialogEntry[]; toast: string; sidebarExpanded: boolean }>({
  dialogs: [],
  toast: '',
  sidebarExpanded: false,
});

let nextId = 1;

export function openDialog(render: DialogEntry['render'], onDismiss?: () => void): () => void {
  const id = nextId++;
  ui.set((s) => ({ dialogs: s.dialogs.concat([{ id, render, onDismiss }]) }));
  return () => closeDialog(id);
}

export function closeDialog(id?: number): void {
  ui.set((s) => ({ dialogs: id === undefined ? s.dialogs.slice(0, -1) : s.dialogs.filter((d) => d.id !== id) }));
}

export function hasDialog(): boolean {
  return ui.get().dialogs.length > 0;
}

/** Back pressed with a dialog open. */
export function dismissTopDialog(): boolean {
  const d = ui.get().dialogs;
  if (!d.length) return false;
  const top = d[d.length - 1];
  closeDialog(top.id);
  if (top.onDismiss) top.onDismiss();
  return true;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, ms = 2600): void {
  clearTimeout(toastTimer);
  ui.set({ toast: message });
  toastTimer = setTimeout(() => ui.set({ toast: '' }), ms);
}
