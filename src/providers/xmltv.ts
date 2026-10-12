// Streaming XMLTV parser. Guides are often 50-300 MB, so we never build a DOM:
// text is fed in chunks and each complete <channel> / <programme> element is parsed with small
// regexes. Only programmes inside a time window are kept.

import type { Programme } from '@/core/models';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon?: string;
}

export interface XmltvOptions {
  /** Keep programmes ending after this time (unix ms). */
  from: number;
  /** Keep programmes starting before this time (unix ms). */
  to: number;
  /** Only keep these channel ids, when given. */
  channels?: Set<string>;
}

const PROG_START = '<programme';
const PROG_END = '</programme>';
const CHAN_START = '<channel';
const CHAN_END = '</channel>';

export class XmltvParser {
  private buf = '';
  constructor(
    private opts: XmltvOptions,
    private onProgramme: (p: Programme) => void,
    private onChannel: (c: XmltvChannel) => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buf += chunk;
    let pos = 0;
    let incomplete = false;
    for (;;) {
      const ps = this.buf.indexOf(PROG_START, pos);
      const cs = this.buf.indexOf(CHAN_START, pos);
      let start: number;
      let endTag: string;
      if (ps < 0 && cs < 0) break;
      if (cs >= 0 && (ps < 0 || cs < ps)) {
        start = cs;
        endTag = CHAN_END;
      } else {
        start = ps;
        endTag = PROG_END;
      }
      // Self-closing element: <channel id="x"/>
      const tagClose = this.buf.indexOf('>', start);
      if (tagClose < 0) {
        pos = start;
        incomplete = true;
        break;
      }
      let end: number;
      if (this.buf.charCodeAt(tagClose - 1) === 47 /* / */) {
        end = tagClose + 1;
      } else {
        const e = this.buf.indexOf(endTag, tagClose);
        if (e < 0) {
          pos = start;
          incomplete = true;
          break;
        }
        end = e + endTag.length;
      }
      const el = this.buf.slice(start, end);
      if (endTag === PROG_END) this.programme(el);
      else this.channel(el);
      pos = end;
    }
    // Keep only the unfinished element, or a possible partial start tag ("<progr").
    this.buf = incomplete ? this.buf.slice(pos) : this.buf.slice(Math.max(pos, this.buf.length - 16));
  }

  end(): void {
    this.push('');
    this.buf = '';
  }

  private programme(el: string) {
    const head = el.slice(0, el.indexOf('>') + 1);
    const channel = attr(head, 'channel');
    if (!channel) return;
    if (this.opts.channels && !this.opts.channels.has(channel)) return;
    const start = parseXmltvDate(attr(head, 'start'));
    const end = parseXmltvDate(attr(head, 'stop')) || start + 30 * 60000;
    if (!start || end <= this.opts.from || start >= this.opts.to) return;
    const title = text(el, 'title');
    if (!title) return;
    this.onProgramme({ channelEpgId: channel, start, end, title, desc: text(el, 'desc') || undefined, category: text(el, 'category') || undefined });
  }

  private channel(el: string) {
    const head = el.slice(0, el.indexOf('>') + 1);
    const id = attr(head, 'id');
    if (!id) return;
    const names: string[] = [];
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(el))) names.push(unescapeXml(m[1]).trim());
    const icon = /<icon[^>]*src="([^"]*)"/.exec(el);
    this.onChannel({ id: unescapeXml(id), names, icon: icon ? unescapeXml(icon[1]) : undefined });
  }
}

function attr(head: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(head) || new RegExp(`\\s${name}='([^']*)'`).exec(head);
  return m ? unescapeXml(m[1]) : '';
}

function text(el: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(el);
  if (!m) return '';
  let s = m[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1].trim();
  s = unescapeXml(s);
  return s.trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(code) ? whole : String.fromCharCode(code);
    }
    return ENTITIES[e] || whole;
  });
}

/** "20240101120000 +0100" -> unix ms. Missing offset = UTC. */
export function parseXmltvDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{2}):?(\d{2}))?/.exec(s.trim());
  if (!m) return 0;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  if (!m[7]) return utc;
  const sign = m[7][0] === '-' ? -1 : 1;
  const offMin = sign * (Math.abs(Number(m[7])) * 60 + Number(m[8] || 0));
  return utc - offMin * 60000;
}
