import type {
  DataTablesValue,
  NavigationValue,
} from '../schemas/user-settings-namespaces.schema';

// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 *
 * DELIBERATELY a `type`, not an `interface` (#186). Prisma's `InputJsonValue`
 * is an index-signature type, and TypeScript only gives an *implicit* index
 * signature to object type aliases — never to interfaces, because an interface
 * can be reopened later with a non-JSON member. Declaring these as interfaces
 * is what forced the `value: … as any` casts on every settings write; as type
 * aliases the values are structurally assignable and `tsc` checks the shape
 * against the column for real. Do not convert back.
 */
export type UserSettingsValue = {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  /**
   * Per-table view preferences, keyed by table id.
   *
   * Optional on purpose, and derived from the zod schema so the two can never
   * drift. Absent means "the user has expressed no table preferences yet" —
   * NOT "empty preferences". See user-settings-namespaces.schema.ts.
   */
  dataTables?: DataTablesValue;
  /**
   * Navigation chrome preferences. Absent means "use built-in defaults".
   */
  navigation?: NavigationValue;
};

/**
 * System settings schema - stored in system_settings.value JSONB
 *
 * A `type` rather than an `interface` for the same reason as
 * `UserSettingsValue` above — see that comment.
 */
export type SystemSettingsValue = {
  ui: {
    allowUserThemeOverride: boolean;
  };
  features: {
    [key: string]: boolean;
  };
};

/**
 * Default user settings
 */
// NOTE: `dataTables` and `navigation` are intentionally NOT listed here.
// Seeding them would turn "absent" into "explicitly empty", which is exactly
// the failure mode the namespaces are designed to avoid (a frozen column set
// that silently hides every column added later).
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    useProviderImage: true,
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
};
