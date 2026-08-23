import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
} from './update-user-settings.dto';
import {
  DATA_TABLE_MAX_ID_LENGTH,
  DATA_TABLE_MAX_VISIBLE_COLUMNS,
  DATA_TABLE_MAX_PAGE_SIZE,
  DATA_TABLE_MAX_TABLES,
} from '../../common/schemas/user-settings-namespaces.schema';

describe('UpdateUserSettingsDto (PUT)', () => {
  describe('theme field', () => {
    it('should accept "light" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'blue',
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should reject empty string as theme', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: '',
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should require theme field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          profile: {
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should accept valid profile object', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: 'John Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/image.jpg',
        },
      });

      expect(result.profile.displayName).toBe('John Doe');
      expect(result.profile.useProviderImage).toBe(false);
      expect(result.profile.customImageUrl).toBe(
        'https://example.com/image.jpg',
      );
    });

    it('should accept profile with null customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
          customImageUrl: null,
        },
      });

      expect(result.profile.customImageUrl).toBeNull();
    });

    it('should make displayName optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBeUndefined();
    });

    it('should accept empty displayName string', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: '',
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBe('');
    });

    it('should accept displayName at maximum length (100 chars)', () => {
      const longName = 'a'.repeat(100);
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: longName,
          useProviderImage: true,
        },
      });

      expect(result.profile.displayName).toBe(longName);
    });

    it('should reject displayName longer than 100 characters', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: tooLongName,
            useProviderImage: true,
          },
        }),
      ).toThrow();
    });

    it('should require useProviderImage field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: 'Test',
          },
        }),
      ).toThrow();
    });

    it('should reject non-boolean useProviderImage', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            useProviderImage: 'true',
          },
        }),
      ).toThrow();
    });

    it('should accept valid URL for customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://cdn.example.com/user/profile.png',
        },
      });

      expect(result.profile.customImageUrl).toBe(
        'https://cdn.example.com/user/profile.png',
      );
    });

    it('should accept http URL for customImageUrl', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'http://example.com/image.jpg',
        },
      });

      expect(result.profile.customImageUrl).toBe(
        'http://example.com/image.jpg',
      );
    });

    it('should reject invalid URL for customImageUrl', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            useProviderImage: false,
            customImageUrl: 'not-a-valid-url',
          },
        }),
      ).toThrow();
    });

    it('should make customImageUrl optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result.profile.customImageUrl).toBeUndefined();
    });

    it('should require profile field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
        }),
      ).toThrow();
    });
  });

  describe('complete settings object', () => {
    it('should accept valid complete user settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/jane.jpg',
        },
      });

      expect(result).toEqual({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          useProviderImage: false,
          customImageUrl: 'https://example.com/jane.jpg',
        },
      });
    });

    it('should accept minimal valid settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });

      expect(result).toEqual({
        theme: 'system',
        profile: {
          useProviderImage: true,
        },
      });
    });
  });
});

describe('PatchUserSettingsDto (PATCH)', () => {
  describe('theme field', () => {
    it('should make theme field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.theme).toBeUndefined();
    });

    it('should accept "light" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'system',
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          theme: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should make profile field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.profile).toBeUndefined();
    });

    it('should accept empty profile object', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {},
      });

      expect(result.profile).toEqual({});
    });

    it('should accept partial profile - only displayName', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Updated Name',
        },
      });

      expect(result.profile?.displayName).toBe('Updated Name');
      expect(result.profile?.useProviderImage).toBeUndefined();
    });

    it('should accept partial profile - only useProviderImage', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          useProviderImage: false,
        },
      });

      expect(result.profile?.useProviderImage).toBe(false);
      expect(result.profile?.displayName).toBeUndefined();
    });

    it('should accept partial profile - only customImageUrl', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          customImageUrl: 'https://example.com/new-image.jpg',
        },
      });

      expect(result.profile?.customImageUrl).toBe(
        'https://example.com/new-image.jpg',
      );
    });

    it('should accept partial profile with null customImageUrl', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          customImageUrl: null,
        },
      });

      expect(result.profile?.customImageUrl).toBeNull();
    });

    it('should validate displayName max length when provided', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            displayName: tooLongName,
          },
        }),
      ).toThrow();
    });

    it('should validate customImageUrl format when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            customImageUrl: 'invalid-url',
          },
        }),
      ).toThrow();
    });

    it('should accept all profile fields together', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'New Name',
          useProviderImage: true,
          customImageUrl: null,
        },
      });

      expect(result.profile).toEqual({
        displayName: 'New Name',
        useProviderImage: true,
        customImageUrl: null,
      });
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only theme field', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result).toEqual({
        theme: 'dark',
      });
    });

    it('should accept update with only profile field', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Test User',
        },
      });

      expect(result).toEqual({
        profile: {
          displayName: 'Test User',
        },
      });
    });

    it('should accept update with both theme and profile', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/avatar.png',
        },
      });

      expect(result).toEqual({
        theme: 'light',
        profile: {
          useProviderImage: false,
          customImageUrl: 'https://example.com/avatar.png',
        },
      });
    });
  });

  describe('dataTables namespace (PUT)', () => {
    const baseValid = {
      theme: 'light' as const,
      profile: { useProviderImage: true },
    };

    it('is optional - absent when not provided', () => {
      const result = updateUserSettingsSchema.parse(baseValid);
      expect(result.dataTables).toBeUndefined();
    });

    it('accepts an empty map', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: {},
      });
      expect(result.dataTables).toEqual({});
    });

    // TRIPWIRE: if a future `.default()` sneaks into dataTableEntrySchema,
    // this is the test that catches it. An entry with no fields set must
    // parse to `{}` - not to an object carrying materialised defaults for
    // visibleColumns/density/pageSize/sort. See the WHY in
    // user-settings-namespaces.schema.ts: a materialised `visibleColumns: []`
    // would permanently hide every column added after the user's first
    // unrelated settings write.
    it('CRITICAL: an entry with no fields set does not materialise visibleColumns/density/pageSize/sort defaults', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: { jobs: {} },
      });

      expect(result.dataTables).toEqual({ jobs: {} });
      expect(result.dataTables?.jobs).not.toHaveProperty('visibleColumns');
      expect(result.dataTables?.jobs).not.toHaveProperty('density');
      expect(result.dataTables?.jobs).not.toHaveProperty('pageSize');
      expect(result.dataTables?.jobs).not.toHaveProperty('sort');
    });

    it('accepts a fully populated entry', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: {
          jobs: {
            visibleColumns: ['id', 'title'],
            density: 'compact',
            pageSize: 25,
            sort: { field: 'title', direction: 'asc' },
          },
        },
      });

      expect(result.dataTables).toEqual({
        jobs: {
          visibleColumns: ['id', 'title'],
          density: 'compact',
          pageSize: 25,
          sort: { field: 'title', direction: 'asc' },
        },
      });
    });

    describe('tableId format', () => {
      it.each([
        ['uppercase letters', 'Jobs'],
        ['leading hyphen', '-jobs'],
        ['punctuation', 'jobs!'],
      ])('rejects a tableId with %s (%j)', (_label, tableId) => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { [tableId]: {} },
          }),
        ).toThrow();
      });

      it('accepts lowercase slugs with digits, hyphens, and underscores', () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { 'jobs-2_v2': {} },
        });
        expect(result.dataTables).toEqual({ 'jobs-2_v2': {} });
      });

      it(`rejects a tableId longer than ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
        const tooLong = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1);
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { [tooLong]: {} },
          }),
        ).toThrow();
      });

      it(`accepts a tableId at exactly ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
        const maxLength = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH);
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { [maxLength]: {} },
        });
        expect(result.dataTables).toEqual({ [maxLength]: {} });
      });
    });

    describe('visibleColumns bound', () => {
      it(`accepts exactly ${DATA_TABLE_MAX_VISIBLE_COLUMNS} columns`, () => {
        const columns = Array.from(
          { length: DATA_TABLE_MAX_VISIBLE_COLUMNS },
          (_, i) => `col${i}`,
        );
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { visibleColumns: columns } },
        });
        expect(result.dataTables?.jobs.visibleColumns).toHaveLength(
          DATA_TABLE_MAX_VISIBLE_COLUMNS,
        );
      });

      it(`rejects more than ${DATA_TABLE_MAX_VISIBLE_COLUMNS} columns`, () => {
        const columns = Array.from(
          { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
          (_, i) => `col${i}`,
        );
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { visibleColumns: columns } },
          }),
        ).toThrow();
      });
    });

    describe('pageSize bound', () => {
      it('rejects pageSize of 0', () => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { pageSize: 0 } },
          }),
        ).toThrow();
      });

      it(`rejects pageSize of ${DATA_TABLE_MAX_PAGE_SIZE + 1}`, () => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
          }),
        ).toThrow();
      });

      it('accepts pageSize of 1', () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { pageSize: 1 } },
        });
        expect(result.dataTables?.jobs.pageSize).toBe(1);
      });

      it(`accepts pageSize of ${DATA_TABLE_MAX_PAGE_SIZE}`, () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE } },
        });
        expect(result.dataTables?.jobs.pageSize).toBe(DATA_TABLE_MAX_PAGE_SIZE);
      });
    });

    it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { desnity: 'compact' } },
        }),
      ).toThrow();
    });

    it(`rejects dataTables: null - PUT states settings in full, so null has no "delete" meaning here`, () => {
      expect(() =>
        updateUserSettingsSchema.parse({ ...baseValid, dataTables: null }),
      ).toThrow();
    });

    it('rejects a null entry value ({ jobs: null }) - the nullable-entry form is PATCH-only', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: null },
        }),
      ).toThrow();
    });

    it(
      `does NOT enforce the ${DATA_TABLE_MAX_TABLES}-table cap by itself - z.record() cannot ` +
        'express a max key count, so this is deliberately accepted here. The cap is ' +
        'enforced in UserSettingsService.assertDataTableLimit (see user-settings.service.spec.ts), ' +
        'against the merged result, precisely so an over-cap request surfaces as a 400 ' +
        'rather than escaping this schema as an uncaught ZodError.',
      () => {
        const tooMany = Object.fromEntries(
          Array.from({ length: DATA_TABLE_MAX_TABLES + 1 }, (_, i) => [
            `table${i}`,
            {},
          ]),
        );
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: tooMany,
        });
        expect(Object.keys(result.dataTables ?? {})).toHaveLength(
          DATA_TABLE_MAX_TABLES + 1,
        );
      },
    );
  });

  describe('navigation namespace (PUT)', () => {
    const baseValid = {
      theme: 'light' as const,
      profile: { useProviderImage: true },
    };

    it('is optional - absent when not provided', () => {
      const result = updateUserSettingsSchema.parse(baseValid);
      expect(result.navigation).toBeUndefined();
    });

    it('accepts an empty object', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        navigation: {},
      });
      expect(result.navigation).toEqual({});
    });

    it('does not materialise a railCollapsed default when omitted', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        navigation: {},
      });
      expect(result.navigation).not.toHaveProperty('railCollapsed');
    });

    it('accepts railCollapsed true and false', () => {
      expect(
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: true },
        }).navigation,
      ).toEqual({ railCollapsed: true });
      expect(
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: false },
        }).navigation,
      ).toEqual({ railCollapsed: false });
    });

    it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollpsed: true },
        }),
      ).toThrow();
    });

    it('rejects navigation: null on PUT - null has no "delete" meaning for a full replace', () => {
      expect(() =>
        updateUserSettingsSchema.parse({ ...baseValid, navigation: null }),
      ).toThrow();
    });

    it('rejects railCollapsed: null on PUT - the nullable-field form is PATCH-only', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: null },
        }),
      ).toThrow();
    });
  });
});

describe('dataTables namespace (PATCH)', () => {
  it('is optional - absent when not provided', () => {
    const result = patchUserSettingsSchema.parse({});
    expect(result.dataTables).toBeUndefined();
  });

  // TRIPWIRE: same intent as the PUT-side test above, exercised through the
  // PATCH schema. A `.default()` sneaking into dataTableEntrySchema would
  // freeze a user's column set the first time they touch an unrelated field.
  it('CRITICAL: a patch entry with no fields set does not materialise visibleColumns/density/pageSize/sort defaults', () => {
    const result = patchUserSettingsSchema.parse({
      dataTables: { jobs: {} },
    });

    expect(result.dataTables).toEqual({ jobs: {} });
    const jobsEntry = (result.dataTables as Record<string, unknown>)?.jobs;
    expect(jobsEntry).not.toHaveProperty('visibleColumns');
    expect(jobsEntry).not.toHaveProperty('density');
    expect(jobsEntry).not.toHaveProperty('pageSize');
    expect(jobsEntry).not.toHaveProperty('sort');
  });

  it('accepts dataTables: null to clear the whole namespace', () => {
    const result = patchUserSettingsSchema.parse({ dataTables: null });
    expect(result.dataTables).toBeNull();
  });

  it('accepts a null entry ({ jobs: null }) to delete a single table', () => {
    const result = patchUserSettingsSchema.parse({
      dataTables: { jobs: null },
    });
    expect(result.dataTables).toEqual({ jobs: null });
  });

  it('rejects an entry with an individually-nulled field ({ jobs: { sort: null } }) - entries replace wholesale, fields are not individually nullable', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        dataTables: { jobs: { sort: null } },
      }),
    ).toThrow();
  });

  describe('tableId format', () => {
    it.each([
      ['uppercase letters', 'Jobs'],
      ['leading hyphen', '-jobs'],
      ['punctuation', 'jobs!'],
    ])('rejects a tableId with %s (%j)', (_label, tableId) => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { [tableId]: {} },
        }),
      ).toThrow();
    });

    it(`rejects a tableId longer than ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1);
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { [tooLong]: {} },
        }),
      ).toThrow();
    });
  });

  describe('bounds', () => {
    it(`rejects more than ${DATA_TABLE_MAX_VISIBLE_COLUMNS} visible columns`, () => {
      const columns = Array.from(
        { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
        (_, i) => `col${i}`,
      );
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { visibleColumns: columns } },
        }),
      ).toThrow();
    });

    it('rejects pageSize of 0', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { pageSize: 0 } },
        }),
      ).toThrow();
    });

    it(`rejects pageSize of ${DATA_TABLE_MAX_PAGE_SIZE + 1}`, () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
        }),
      ).toThrow();
    });

    it('accepts pageSize of 1', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { pageSize: 1 } },
      });
      expect(result.dataTables).toEqual({ jobs: { pageSize: 1 } });
    });

    it(`accepts pageSize of ${DATA_TABLE_MAX_PAGE_SIZE}`, () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE } },
      });
      expect(result.dataTables).toEqual({
        jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE },
      });
    });
  });

  it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        dataTables: { jobs: { desnity: 'compact' } },
      }),
    ).toThrow();
  });
});

describe('navigation namespace (PATCH)', () => {
  it('is optional - absent when not provided', () => {
    const result = patchUserSettingsSchema.parse({});
    expect(result.navigation).toBeUndefined();
  });

  it('accepts navigation: null to clear the whole namespace', () => {
    const result = patchUserSettingsSchema.parse({ navigation: null });
    expect(result.navigation).toBeNull();
  });

  it('accepts railCollapsed: null to delete just that field', () => {
    const result = patchUserSettingsSchema.parse({
      navigation: { railCollapsed: null },
    });
    expect(result.navigation).toEqual({ railCollapsed: null });
  });

  it('accepts railCollapsed: true', () => {
    const result = patchUserSettingsSchema.parse({
      navigation: { railCollapsed: true },
    });
    expect(result.navigation).toEqual({ railCollapsed: true });
  });

  it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        navigation: { railCollpsed: true },
      }),
    ).toThrow();
  });
});
