// Saving and opening a file (backup / restore). On the TV this uses a USB drive through the Tizen
// filesystem API; in a desktop browser it downloads / opens a file.

import { isTizen } from './tv';

declare const tizen: any;

export const BACKUP_NAME = 'termtv-backup.json';

function usbRoots(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      tizen.filesystem.listStorages(
        (storages: Array<{ label: string; type: string; state: string }>) =>
          resolve(storages.filter((s) => s.type === 'EXTERNAL' && s.state === 'MOUNTED').map((s) => s.label)),
        () => resolve([]),
      );
    } catch {
      resolve([]);
    }
  });
}

function resolveDir(label: string): Promise<any> {
  return new Promise((resolve, reject) => tizen.filesystem.resolve(label, resolve, reject, 'rw'));
}

export async function saveTextFile(name: string, text: string): Promise<string> {
  if (!isTizen) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    return name;
  }
  const roots = await usbRoots();
  if (!roots.length) throw new Error('NO_USB');
  const dir = await resolveDir(roots[0]);
  let file: any;
  try {
    file = dir.resolve(name);
  } catch {
    file = dir.createFile(name);
  }
  await new Promise<void>((resolve, reject) =>
    file.openStream(
      'w',
      (stream: any) => {
        stream.write(text);
        stream.close();
        resolve();
      },
      reject,
      'UTF-8',
    ),
  );
  return `${roots[0]}/${name}`;
}

export async function openTextFile(name: string): Promise<string> {
  if (!isTizen) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const f = input.files && input.files[0];
        if (!f) return reject(new Error('NO_FILE'));
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsText(f);
      };
      input.click();
    });
  }
  const roots = await usbRoots();
  for (const root of roots) {
    try {
      const dir = await resolveDir(root);
      const file = dir.resolve(name);
      return await new Promise<string>((resolve, reject) => file.readAsText(resolve, reject, 'UTF-8'));
    } catch {
      /* try the next drive */
    }
  }
  throw new Error(roots.length ? 'NO_FILE' : 'NO_USB');
}
