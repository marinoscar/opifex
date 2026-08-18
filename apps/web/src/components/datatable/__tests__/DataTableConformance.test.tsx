/**
 * Component tests — the shared DataTable conformance suite (issue #257).
 *
 * This file's entire job is to invoke the reusable suite
 * (`conformance/runDataTableConformanceSuite.tsx`) against the built-in
 * fixture table. See that module's docblock for the full contract this
 * exercises, and for how a migrating page (#258 onward) can invoke the same
 * suite against its own columns. See docs/specs/datatable.md §17 for the
 * accessibility contract and keyboard model this suite enforces.
 */

import { describe } from 'vitest';
import { runDataTableConformanceSuite } from './conformance/runDataTableConformanceSuite';

describe('DataTable — shared conformance suite (issue #257)', () => {
  runDataTableConformanceSuite();
});
