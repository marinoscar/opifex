/**
 * "No DOM node contains this value" — the client-side counterpart of the
 * whole-response grep #338 uses on the server (#349, epic #332).
 *
 * ## Why a scanner rather than a set of `queryByText` assertions
 *
 * The acceptance criterion is not "the hint is masked" or "the field is a
 * password field". Those are things somebody thought of. A credential leaks
 * through the channel nobody thought of: a `title` on a tooltip, an
 * `aria-label` built by interpolating a value, a `data-` attribute a
 * component library copies from a prop, a debug `JSON.stringify(entry)` added
 * while chasing something else, a `defaultValue` reflected into the markup, a
 * `<pre>` in an error boundary. Asserting on the nodes a test author
 * remembered leaves every other channel unguarded, which is exactly the shape
 * of failure that gets discovered in a screenshot.
 *
 * So this walks EVERY node under the container and reports every place a value
 * appears: text nodes, comment nodes, every attribute of every element, and —
 * optionally — the `value` PROPERTY of every input and textarea, which is
 * where React puts a controlled field's contents and which never appears in
 * `innerHTML` at all. That last one is the channel a naive
 * `expect(container.innerHTML).not.toContain(secret)` misses completely, and
 * it is the most likely one for a credential.
 *
 * ## The two ways it is used
 *
 * `expectNoLeak(container, value)` — for a value the screen must never hold
 * anywhere, including in an input.
 *
 * `expectNoLeak(container, value, { allowInputValues: true })` — for a value
 * the operator is TYPING. It has to be in the input they typed it into; what
 * must not happen is it reaching a heading, a confirmation dialog, a helper
 * line, an attribute or a summary chip.
 *
 * `domSecrets.test.ts` plants a leak in each channel and asserts this finds
 * it, so a passing leak test in the section suite means something.
 */

export interface LeakScanOptions {
  /**
   * Permit the value inside `input.value` / `textarea.value`, for a field the
   * operator is currently typing into. Everything else is still scanned.
   */
  allowInputValues?: boolean;
}

export interface Leak {
  /** Where it was found, in a form a failure message can print. */
  where: string;
  /** A little of what was around it, for orientation. */
  sample: string;
}

/** Every place `value` appears under `root`. Empty when there is no leak. */
export function findLeaks(
  root: HTMLElement,
  value: string,
  options: LeakScanOptions = {},
): Leak[] {
  if (value === '') {
    throw new Error(
      'A leak scan for the empty string would match everywhere and prove ' +
        'nothing. Pass the real value.',
    );
  }

  const leaks: Leak[] = [];

  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  );

  const record = (where: string, haystack: string) => {
    if (haystack.includes(value)) {
      leaks.push({ where, sample: excerpt(haystack, value) });
    }
  };

  // The root itself is not visited by the walker.
  scanElement(root, record, options);

  let node = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      scanElement(node as Element, record, options);
    } else {
      // Text and comment nodes: `data` is the whole of their content, and
      // reading it per node rather than via `textContent` keeps the report
      // pointed at the node that actually carries the value.
      record(describe(node.parentElement), node.nodeValue ?? '');
    }
    node = walker.nextNode();
  }

  return leaks;
}

function scanElement(
  element: Element,
  record: (where: string, haystack: string) => void,
  options: LeakScanOptions,
): void {
  for (const attribute of Array.from(element.attributes)) {
    record(`${describe(element)}[${attribute.name}]`, attribute.value);
  }

  if (
    !options.allowInputValues &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement)
  ) {
    // The property, not the attribute. React does not reflect a typed or
    // controlled value into the markup, so this is invisible to any check
    // that reads `innerHTML`.
    record(`${describe(element)}.value`, element.value);
  }
}

function describe(element: Element | null): string {
  if (!element) return '(detached node)';
  const id = element.id ? `#${element.id}` : '';
  const label = element.getAttribute('aria-label');
  return `<${element.tagName.toLowerCase()}${id}${label ? ` aria-label="${label}"` : ''}>`;
}

function excerpt(haystack: string, needle: string): string {
  const at = haystack.indexOf(needle);
  const from = Math.max(0, at - 30);
  return `…${haystack.slice(from, at + needle.length + 30)}…`;
}

/**
 * Fails, naming every channel the value reached.
 *
 * The message lists the leaks rather than saying "expected false to be true",
 * because the point of finding one is knowing where it came from.
 */
export function expectNoLeak(
  root: HTMLElement,
  value: string,
  options: LeakScanOptions = {},
): void {
  const leaks = findLeaks(root, value, options);

  if (leaks.length > 0) {
    const report = leaks
      .map((leak) => `  ${leak.where}: ${leak.sample}`)
      .join('\n');
    throw new Error(
      `A secret reached ${leaks.length} DOM location(s):\n${report}`,
    );
  }
}
