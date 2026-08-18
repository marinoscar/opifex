import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';
import { userSettingsSchema } from '../../common/schemas/settings.schema';
import {
  DATA_TABLE_MAX_TABLES,
  DataTablesPatchValue,
  DataTablesValue,
  NavigationPatchValue,
  NavigationValue,
} from '../../common/schemas/user-settings-namespaces.schema';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the API response projection for a stored settings value.
   *
   * Optional namespaces are emitted ONLY when present — we never put
   * `dataTables: undefined` in the body, because an absent namespace is the
   * signal to the client that it should apply its own built-in defaults.
   */
  private toResponse(
    value: UserSettingsValue,
    updatedAt: Date,
    version: number,
  ) {
    return {
      theme: value.theme,
      profile: value.profile,
      ...(value.dataTables !== undefined
        ? { dataTables: value.dataTables }
        : {}),
      ...(value.navigation !== undefined
        ? { navigation: value.navigation }
        : {}),
      updatedAt,
      version,
    };
  }

  /**
   * Get user settings for current user
   * Creates default settings if none exist
   */
  async getSettings(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if not found
    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Replace user settings (PUT)
   */
  async replaceSettings(userId: string, dto: UpdateUserSettingsDto) {
    // Validate against schema.
    //
    // WARNING: this line silently STRIPS any key the schema does not know
    // about. It is exactly the line that made adding `dataTables` /
    // `navigation` a six-file change: a namespace missing from
    // `userSettingsSchema` is accepted by the controller, dropped here, and
    // never seen again by a subsequent GET — with no error anywhere. If you
    // are adding a new namespace, add it to
    // common/schemas/user-settings-namespaces.schema.ts and wire it into
    // `userSettingsSchema` before anything else.
    const validated = userSettingsSchema.parse(dto);

    // Cap enforced here rather than in zod — see assertDataTableLimit.
    this.assertDataTableLimit(validated.dataTables);

    const settings = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {
        value: validated as any,
        version: { increment: 1 },
      },
      create: {
        userId,
        value: validated as any,
      },
    });

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Partial update user settings (PATCH)
   * Uses JSON Merge Patch semantics
   */
  async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings(userId);

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Merge with existing settings
    const merged: UserSettingsValue = {
      theme: dto.theme ?? current.theme,
      profile: {
        displayName:
          dto.profile?.displayName !== undefined
            ? dto.profile.displayName
            : current.profile.displayName,
        useProviderImage:
          dto.profile?.useProviderImage !== undefined
            ? dto.profile.useProviderImage
            : current.profile.useProviderImage,
        customImageUrl:
          dto.profile?.customImageUrl !== undefined
            ? dto.profile.customImageUrl
            : current.profile.customImageUrl,
      },
    };

    // Optional namespaces: only set the key when the merge produced something,
    // so an emptied namespace collapses back to absent instead of being stored
    // as `{}` (absent means "use built-in defaults", `{}` would not).
    const mergedDataTables = this.mergeDataTables(
      current.dataTables,
      dto.dataTables,
    );
    if (mergedDataTables !== undefined) {
      merged.dataTables = mergedDataTables;
    }

    const mergedNavigation = this.mergeNavigation(
      current.navigation,
      dto.navigation,
    );
    if (mergedNavigation !== undefined) {
      merged.navigation = mergedNavigation;
    }

    // Enforce the table cap AFTER the merge — see assertDataTableLimit.
    this.assertDataTableLimit(merged.dataTables);

    // Validate merged result.
    //
    // WARNING: as in replaceSettings, this call silently strips unknown keys.
    // A namespace that is not part of `userSettingsSchema` disappears right
    // here and never round-trips through GET. See the note in replaceSettings.
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        value: validated as any,
        version: { increment: 1 },
      },
    });

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Merge the `dataTables` namespace using JSON Merge Patch semantics,
   * PER TABLE ID.
   *
   * - patch absent            -> keep the stored namespace untouched
   * - patch is `null`         -> clear the whole namespace
   * - `{ jobs: null }`        -> delete the `jobs` entry, leave others alone
   * - `{ jobs: { pageSize } }`-> REPLACE the `jobs` entry wholesale. This is
   *   deliberately not a deep merge: a table's preferences are a single
   *   coherent view state, and a client that sends a partial entry is stating
   *   the entry it wants, so any previously stored `density` for `jobs` is
   *   discarded. Entries for other tables are never affected.
   *
   * An empty result collapses to `undefined` so the namespace disappears from
   * storage rather than persisting as `{}`.
   */
  private mergeDataTables(
    current: DataTablesValue | undefined,
    patch: DataTablesPatchValue | null | undefined,
  ): DataTablesValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: DataTablesValue = { ...(current ?? {}) };

    for (const [tableId, entry] of Object.entries(patch)) {
      if (entry === null) {
        delete merged[tableId];
      } else if (entry !== undefined) {
        merged[tableId] = entry;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `navigation` namespace field-wise.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the client falls back to
   *   its built-in default rather than to a hard-coded stored one
   *
   * As with dataTables, an empty result collapses to `undefined`.
   */
  private mergeNavigation(
    current: NavigationValue | undefined,
    patch: NavigationPatchValue | null | undefined,
  ): NavigationValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: NavigationValue = { ...(current ?? {}) };

    if (patch.railCollapsed === null) {
      delete merged.railCollapsed;
    } else if (patch.railCollapsed !== undefined) {
      merged.railCollapsed = patch.railCollapsed;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Enforce the per-user cap on the number of persisted data table entries.
   *
   * This is a storage-exhaustion control (see
   * user-settings-namespaces.schema.ts), and it is enforced HERE rather than in
   * zod for two reasons:
   *
   * 1. `z.record()` cannot express "at most N keys" — there is no key-count
   *    refinement that survives the record type.
   * 2. Even if it could, the cap has to be checked against the MERGED result,
   *    not the request body: a 3-entry patch on top of 39 stored entries is
   *    over the cap while the body alone is not. Doing that check inside the
   *    post-merge `userSettingsSchema.parse()` would surface it as a raw
   *    `ZodError` thrown from the service — which escapes as a 500, not the
   *    400 the client deserves. Hence an explicit BadRequestException.
   */
  private assertDataTableLimit(dataTables: DataTablesValue | undefined): void {
    if (!dataTables) {
      return;
    }

    const count = Object.keys(dataTables).length;
    if (count > DATA_TABLE_MAX_TABLES) {
      throw new BadRequestException(
        `Too many data table preferences: ${count} exceeds the maximum of ${DATA_TABLE_MAX_TABLES}. Remove entries for tables you no longer use (send them as null) before adding new ones.`,
      );
    }
  }

  /**
   * Sync display name from settings to user table
   */
  private async syncDisplayName(
    userId: string,
    displayName: string | undefined,
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: displayName || null },
    });
  }

  /**
   * Update profile image preference
   */
  async updateProfileImage(
    userId: string,
    useProviderImage: boolean,
    customImageUrl?: string | null,
  ) {
    return this.patchSettings(userId, {
      profile: {
        useProviderImage,
        customImageUrl,
      },
    });
  }

  /**
   * Update theme preference
   */
  async updateTheme(userId: string, theme: 'light' | 'dark' | 'system') {
    return this.patchSettings(userId, { theme });
  }
}
