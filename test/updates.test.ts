import { compareVersions, plainNotes } from '@/state/updates';

describe('updates', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('v0.1.12', '0.1.12')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
  });
  it('turns release notes into plain text', () => {
    expect(plainNotes('## v1\n\n- **Fast** start\n- see [docs](http://x)\n')).toBe('v1\n\n• Fast start\n• see docs');
  });
});
