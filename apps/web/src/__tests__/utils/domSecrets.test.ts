/**
 * The leak scanner's own tests (#349, epic #332).
 *
 * A whole-DOM scan that found nothing would pass just as happily if it were
 * broken, and the section suite's headline assertion rests entirely on it. So
 * every channel it claims to cover gets a planted leak here: text, an
 * attribute nobody would think to query, an `aria-label`, a comment, and the
 * `value` PROPERTY of an input — which never appears in `innerHTML` and is
 * therefore the one a naive check misses.
 */

import { describe, expect, it } from 'vitest';

import { expectNoLeak, findLeaks } from './domSecrets';

const SECRET = 'ghp_leakcanary_0123456789abcdef';

function container(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('findLeaks', () => {
  it('finds nothing in a document that does not carry the value', () => {
    expect(
      findLeaks(container('<p>****cdef is configured</p>'), SECRET),
    ).toEqual([]);
  });

  it('finds it in text', () => {
    expect(
      findLeaks(container(`<p>token: ${SECRET}</p>`), SECRET),
    ).toHaveLength(1);
  });

  it('finds it in an attribute nobody would have queried', () => {
    const leaks = findLeaks(
      container(`<span title="copied ${SECRET}">token</span>`),
      SECRET,
    );

    expect(leaks).toHaveLength(1);
    expect(leaks[0].where).toContain('[title]');
  });

  it('finds it in an aria-label built by interpolation', () => {
    expect(
      findLeaks(
        container(`<button aria-label="test ${SECRET}">Test</button>`),
        SECRET,
      ),
    ).toHaveLength(1);
  });

  it('finds it in a comment', () => {
    expect(
      findLeaks(container(`<div><!-- debug: ${SECRET} --></div>`), SECRET),
    ).toHaveLength(1);
  });

  it('finds it in an input value property, which innerHTML never shows', () => {
    const root = container('<input type="password" />');
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = SECRET;

    // The channel the naive assertion misses, demonstrated rather than
    // asserted about in the abstract.
    expect(root.innerHTML).not.toContain(SECRET);
    expect(findLeaks(root, SECRET)).toHaveLength(1);
  });

  it('permits an input value only when the caller says the field is being typed into', () => {
    const root = container('<input type="password" />');
    const input = root.querySelector('input') as HTMLInputElement;
    input.value = SECRET;

    expect(findLeaks(root, SECRET, { allowInputValues: true })).toEqual([]);
    // …and still scans everything else in that mode.
    input.setAttribute('data-value', SECRET);
    expect(findLeaks(root, SECRET, { allowInputValues: true })).toHaveLength(1);
  });

  it('scans the root element itself, not only its descendants', () => {
    const root = container('<p>nothing</p>');
    root.setAttribute('data-debug', SECRET);

    expect(findLeaks(root, SECRET)).toHaveLength(1);
  });

  it('refuses to scan for the empty string', () => {
    // Which would match every node and report a clean screen as catastrophic
    // — or, in a suite that expected leaks, hide a real one.
    expect(() => findLeaks(container('<p>x</p>'), '')).toThrow(/empty string/i);
  });
});

describe('expectNoLeak', () => {
  it('passes silently on a clean tree', () => {
    expect(() =>
      expectNoLeak(container('<p>masked</p>'), SECRET),
    ).not.toThrow();
  });

  it('names where the value was found', () => {
    expect(() =>
      expectNoLeak(container(`<span title="${SECRET}">x</span>`), SECRET),
    ).toThrow(/\[title\]/);
  });
});
