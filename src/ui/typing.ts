import type { KeyInfo } from '@/platform/tv';
import { isTizen } from '@/platform/tv';

/** The character a key press types into a text field, if any (digits, letters, and Space on a desktop keyboard). */
export function typedChar(k: KeyInfo): string {
  if (k.key === 'char' && k.char) return k.char;
  if (k.key === 'digit' && k.digit !== undefined) return String(k.digit);
  if (k.key === 'playPause' && !isTizen) return ' ';
  return '';
}
