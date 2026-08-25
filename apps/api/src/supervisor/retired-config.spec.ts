import { Logger } from '@nestjs/common';

import {
  RETIRED_LIVE_RUN_CEILING_ENV,
  RETIRED_SUPERVISOR_SETTINGS,
  RetiredSupervisorConfigService,
  retiredSupervisorWarnings,
} from './retired-config';

/**
 * The boot warning for a setting ADR-0016 removed.
 *
 * The requirement is narrow and worth stating exactly: an operator who set
 * `SUPERVISOR_LIVE_RUN_CEILING` must be TOLD it no longer does anything, and
 * an operator who never set it must not be told anything at all. Silently
 * ignoring a value somebody supplied is the failure this exists to prevent --
 * the same standard `hard-spend-ceiling.ts` holds itself to.
 */
describe('retired supervisor settings (ADR-0016)', () => {
  describe('which environments earn a warning', () => {
    it('warns when the retired ceiling is still set', () => {
      const warnings = retiredSupervisorWarnings({
        [RETIRED_LIVE_RUN_CEILING_ENV]: '4',
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(RETIRED_LIVE_RUN_CEILING_ENV);
    });

    it('says nothing when it is unset, which is nearly every deployment', () => {
      // The default has been off since the key existed. A boot line about a
      // setting nobody chose is noise, and noise is what teaches an operator
      // to skim the warnings that do matter.
      expect(retiredSupervisorWarnings({})).toEqual([]);
    });

    it('treats an exported-but-empty value as unset', () => {
      // The removed `configuration.ts` read was falsy-guarded, so an empty
      // string was already no ceiling. Warning about it now would report a
      // control that was never in force.
      expect(
        retiredSupervisorWarnings({ [RETIRED_LIVE_RUN_CEILING_ENV]: '' }),
      ).toEqual([]);
      expect(
        retiredSupervisorWarnings({ [RETIRED_LIVE_RUN_CEILING_ENV]: '   ' }),
      ).toEqual([]);
    });

    it('warns on a malformed value too, rather than on a parseable one only', () => {
      // There is nothing left to parse it into. What the operator needs to
      // know is that the variable is dead, which is true of '4' and of 'four'
      // alike.
      expect(
        retiredSupervisorWarnings({ [RETIRED_LIVE_RUN_CEILING_ENV]: 'four' }),
      ).toHaveLength(1);
    });
  });

  describe('what the warning says', () => {
    const [warning] = retiredSupervisorWarnings({
      [RETIRED_LIVE_RUN_CEILING_ENV]: '4',
    });

    it('names the variable, the value, and that it does nothing', () => {
      expect(warning).toContain(RETIRED_LIVE_RUN_CEILING_ENV);
      expect(warning).toContain('"4"');
      expect(warning).toContain('NO EFFECT');
    });

    it('names the decision and where to read it', () => {
      // A warning that says a setting is dead without saying who killed it
      // leaves the operator with a second question and no way to answer it.
      expect(warning).toContain('ADR-0016');
      expect(warning).toContain('docs/adr/0016-supervisor-live-run-ceiling.md');
    });

    it('says what still covers the concern the ceiling was reached for', () => {
      expect(warning).toContain('SUPERVISOR_STAND_DOWN_WHEN_BLOCKED');
      // Names the variable rather than the issue, now that one exists.
      // Pointing an operator at a GitHub issue was the best available answer
      // while #261 was open; a setting they can actually export is a better
      // one, and leaving the issue number there would have them reading a
      // closed thread to find a value this line could just tell them.
      expect(warning).toContain('SUPERVISOR_HARD_SPEND_CEILING_USD');
      expect(warning).toContain('ADR-0017');
    });

    it('does not claim the supervisor competes for anyone else’s quota', () => {
      // The claim ADR-0015 falsified, in the one place an operator reads.
      expect(warning).not.toMatch(/shared quota|competing|yields/i);
    });
  });

  describe('the service that emits it', () => {
    const original = process.env[RETIRED_LIVE_RUN_CEILING_ENV];

    afterEach(() => {
      jest.restoreAllMocks();
      if (original === undefined)
        delete process.env[RETIRED_LIVE_RUN_CEILING_ENV];
      else process.env[RETIRED_LIVE_RUN_CEILING_ENV] = original;
    });

    it('warns once at construction when the variable is set', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      process.env[RETIRED_LIVE_RUN_CEILING_ENV] = '4';

      new RetiredSupervisorConfigService();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(RETIRED_LIVE_RUN_CEILING_ENV);
    });

    it('is silent at construction when the variable is unset', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      delete process.env[RETIRED_LIVE_RUN_CEILING_ENV];

      new RetiredSupervisorConfigService();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('lists the retired ceiling exactly once', () => {
    // A duplicated row would warn twice about the same variable, which reads
    // like two problems.
    const names = RETIRED_SUPERVISOR_SETTINGS.map((setting) => setting.env);
    expect(names).toEqual([RETIRED_LIVE_RUN_CEILING_ENV]);
  });
});
