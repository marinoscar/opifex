/**
 * The Control Center section registry (#347, epic #332).
 *
 * The registry is the seam #348–#351 land in, so the invariants worth pinning
 * are the ones a future section could break silently: a duplicate key (two
 * tabs, one of them unreachable), a planned section with no issue behind it
 * ("coming soon" — the claim nobody can check), and a `?section=` value that
 * selects nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_CENTER_SECTIONS,
  DEFAULT_SECTION,
  isControlCenterSectionKey,
  resolveSection,
} from '../../config/controlCenter';

describe('control center sections', () => {
  it('gives every section a unique key', () => {
    const keys = CONTROL_CENTER_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lands on Readiness, and Readiness is built', () => {
    // The landing section is the one that answers "can this deployment do
    // anything at all", so it is also the one that must never be a placeholder.
    expect(DEFAULT_SECTION).toBe('readiness');
    const landing = CONTROL_CENTER_SECTIONS.find(
      (section) => section.key === DEFAULT_SECTION,
    );
    expect(landing?.status).toBe('live');
  });

  it('names the issue that delivers every section, planned or not', () => {
    // "Coming soon" is not a claim anyone can check; "arrives in #350" is.
    for (const section of CONTROL_CENTER_SECTIONS) {
      expect(section.issue, `${section.key} has no issue`).toBeGreaterThan(0);
    }
  });

  it('declares the four sections the rest of the epic delivers', () => {
    // #348 registry-driven settings, #349 secrets and test buttons, #350 the
    // repository ladder, #351 change history. Declared now so landing one is a
    // status flip plus a component, never a change to the shell.
    const planned = CONTROL_CENTER_SECTIONS.filter(
      (section) => section.status === 'planned',
    ).map((section) => section.issue);

    expect(planned).toEqual([348, 349, 350, 351]);
  });

  it('gives every section a description that is a sentence, not a label', () => {
    for (const section of CONTROL_CENTER_SECTIONS) {
      expect(section.description.length).toBeGreaterThan(40);
    }
  });

  it('quotes the VISION phase verbatim on every section', () => {
    // `NotWiredState` renders it as "Arrives in …", and a paraphrase would be
    // a string an operator cannot find in the vision document.
    for (const section of CONTROL_CENTER_SECTIONS) {
      expect(section.phase).toBe('Phase 5 — Cockpit');
    }
  });
});

describe('resolveSection', () => {
  it('selects a section a query parameter names', () => {
    expect(resolveSection('history')).toBe('history');
  });

  it('falls back to the default rather than rendering nothing', () => {
    // A bookmark from before a section was renamed should land the operator on
    // Readiness, not on a blank panel.
    expect(resolveSection('does-not-exist')).toBe(DEFAULT_SECTION);
    expect(resolveSection(null)).toBe(DEFAULT_SECTION);
    expect(resolveSection(undefined)).toBe(DEFAULT_SECTION);
  });

  it('recognises exactly the declared keys', () => {
    for (const section of CONTROL_CENTER_SECTIONS) {
      expect(isControlCenterSectionKey(section.key)).toBe(true);
    }
    expect(isControlCenterSectionKey('readines')).toBe(false);
  });
});
