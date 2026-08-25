import {
  ALL_INPUT_LABELS,
  ALL_MIRROR_LABELS,
  INPUT_LABELS,
  INPUT_LABEL_PREFIX,
  MIRROR_LABELS,
  MIRROR_LABEL_PREFIX,
  isInputLabel,
  isMirrorLabel,
  isUnknownInputLabel,
} from './factory-labels';

describe('factory labels', () => {
  it('separates the two kinds by their separator, and only by it', () => {
    // VISION §3.3 encodes the input/mirror distinction in the separator so it
    // cannot blur in practice. If these ever became the same character the
    // whole read-side filter would silently stop working.
    expect(INPUT_LABEL_PREFIX).toBe('factory:');
    expect(MIRROR_LABEL_PREFIX).toBe('factory/');
    expect(INPUT_LABEL_PREFIX).not.toBe(MIRROR_LABEL_PREFIX);
  });

  it('gives every input label the input prefix and no mirror label an input prefix', () => {
    for (const label of ALL_INPUT_LABELS) {
      expect(label.startsWith(INPUT_LABEL_PREFIX)).toBe(true);
      expect(isMirrorLabel(label)).toBe(false);
    }
    for (const label of ALL_MIRROR_LABELS) {
      expect(label.startsWith(MIRROR_LABEL_PREFIX)).toBe(true);
      expect(isInputLabel(label)).toBe(false);
    }
  });

  it('recognises exactly the three input labels VISION §3.3 names', () => {
    expect([...ALL_INPUT_LABELS].sort()).toEqual([
      'factory:clear-quarantine',
      'factory:hold',
      'factory:ready',
    ]);
  });

  it('recognises exactly the five mirror labels', () => {
    // Four report what the factory is DOING and are mutually exclusive;
    // `factory/label-ignored` (#297) reports something about the INPUT and can
    // accompany any of them. Pinned rather than derived, because the point of
    // the list is that a fifth could not be added quietly — and the fifth was
    // added on purpose, with `.github/labels.yml` updated in the same change.
    expect([...ALL_MIRROR_LABELS].sort()).toEqual([
      'factory/blocked',
      'factory/dispatched',
      'factory/label-ignored',
      'factory/quarantine',
      'factory/review',
    ]);
  });

  describe('isUnknownInputLabel', () => {
    it('flags a mistyped input label rather than letting it pass silently', () => {
      // An operator who typed this and got silence has no way to discover
      // that nothing is holding.
      expect(isUnknownInputLabel('factory:hold-please')).toBe(true);
    });

    it('does not flag a recognised one', () => {
      expect(isUnknownInputLabel(INPUT_LABELS.HOLD)).toBe(false);
    });

    it('does not flag a mirror label', () => {
      expect(isUnknownInputLabel(MIRROR_LABELS.DISPATCHED)).toBe(false);
    });

    it('does not flag an ordinary label', () => {
      expect(isUnknownInputLabel('bug')).toBe(false);
    });
  });

  describe('isMirrorLabel', () => {
    it('is true for anything under the mirror prefix, including one not yet defined', () => {
      // The filter is prefix-based on purpose: a mirror label added by a
      // future issue must be excluded from reads the day it is written, not
      // the day someone remembers to add it to a list.
      expect(isMirrorLabel('factory/some-future-state')).toBe(true);
    });

    it('is false for an ordinary label', () => {
      expect(isMirrorLabel('enhancement')).toBe(false);
    });
  });
});
