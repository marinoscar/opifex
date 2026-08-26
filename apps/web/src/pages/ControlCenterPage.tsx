/**
 * The Control Center — `/admin/settings` (#347, epic #332).
 *
 * ## What it replaced, and why not extend it
 *
 * `SystemSettingsPage` was three tabs: one switch, a `Record<string, boolean>`
 * of feature flags with zero non-test consumers, and a raw JSON textarea. None
 * of it addressed the job epic #332 exists for — an operator configuring
 * Opifex without hand-editing `infra/compose/.env` and recreating containers —
 * so it was replaced rather than grown. The JSON editor in particular could
 * not survive: an editor that bypasses per-field validation is a foot-gun the
 * moment a spend ceiling or a credential lives behind it.
 *
 * `ui.allowUserThemeOverride` was carried across deliberately. See
 * `components/controlcenter/InterfaceSection.tsx`.
 *
 * ## The shell, and what the rest of the epic plugs into
 *
 * Sections come from `config/controlCenter.ts` and are selected by
 * `?section=`. #348, #349, #350 and #351 each replace one `planned` entry with
 * a component; none of them should need to touch this file beyond adding a
 * case to the switch below. Everything a section needs that is shared —
 * permission, the settings document, the save path, the section navigator —
 * is resolved here once.
 *
 * ## Authorization is the API's, and this only hides what it would refuse
 *
 * `RequirePermission` on the route in `App.tsx` is the enforcement point, and
 * the check here is the same string (`system_settings:read`) so a direct
 * render of this component behaves identically. `system_settings:write` gates
 * the controls, not the page: a reader entitled to see the configuration is
 * entitled to see it, and the API refuses the write regardless.
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Container,
  Paper,
  Snackbar,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { Navigate, useSearchParams } from 'react-router-dom';

import { InterfaceSection } from '../components/controlcenter/InterfaceSection';
import { PlannedSectionPanel } from '../components/controlcenter/PlannedSectionPanel';
import { ReadinessSection } from '../components/controlcenter/ReadinessSection';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import {
  CONTROL_CENTER_SECTIONS,
  SECTION_PARAM,
  resolveSection,
  type ControlCenterSection,
  type ControlCenterSectionKey,
} from '../config/controlCenter';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { useReadiness } from '../hooks/useReadiness';
import { useSystemSettings } from '../hooks/useSystemSettings';

const READ_PERMISSION = 'system_settings:read';
const WRITE_PERMISSION = 'system_settings:write';

/**
 * The permission gate, and nothing else.
 *
 * Split from the body so the redirect happens BEFORE any data hook runs — a
 * viewer who lands here by typing the URL should not fire a `/system-settings`
 * request that is certain to 403, and a component cannot conditionally skip
 * its own hooks.
 */
export default function ControlCenterPage() {
  const { hasPermission } = usePermissions();

  if (!hasPermission(READ_PERMISSION)) {
    return <Navigate to="/" replace />;
  }

  return <ControlCenter canWrite={hasPermission(WRITE_PERMISSION)} />;
}

function ControlCenter({ canWrite }: { canWrite: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeKey = resolveSection(searchParams.get(SECTION_PARAM));

  const { settings, isLoading, error, isSaving, updateSettings } =
    useSystemSettings();
  const readiness = useReadiness();
  const { refreshUser } = useAuth();

  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const goToSection = useCallback(
    (key: ControlCenterSectionKey) => {
      setSearchParams({ [SECTION_PARAM]: key });
    },
    [setSearchParams],
  );

  const saveThemePolicy = useCallback(
    async (allowUserThemeOverride: boolean) => {
      try {
        await updateSettings({ ui: { allowUserThemeOverride } });
        // Re-read rather than infer. `/auth/me` is how this flag reaches every
        // consumer, including the administrator who just changed it, so the
        // honest way to show the new value is to fetch it.
        await refreshUser();
        setSavedMessage('Saved. The API returned the updated document.');
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save');
      }
    },
    [updateSettings, refreshUser],
  );

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const activeSection = CONTROL_CENTER_SECTIONS.find(
    (section) => section.key === activeKey,
  ) as ControlCenterSection;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Control Center
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          What this deployment is configured to do, what it is observed to be
          doing, and the difference between the two
          {!canWrite && ' (read-only)'}.
        </Typography>

        {settings?.updatedBy && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Last updated by {settings.updatedBy.email} on{' '}
            {new Date(settings.updatedAt).toLocaleString()}
          </Typography>
        )}
        {settings && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            System settings document version {settings.version}
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Paper sx={{ mt: 2 }}>
          <Tabs
            value={activeKey}
            onChange={(_, next: ControlCenterSectionKey) => goToSection(next)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
            aria-label="Control Center sections"
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            {CONTROL_CENTER_SECTIONS.map((section) => (
              <Tab
                key={section.key}
                value={section.key}
                label={section.label}
                icon={<section.Icon fontSize="small" />}
                iconPosition="start"
              />
            ))}
          </Tabs>

          <Box sx={{ p: { xs: 2, sm: 3 } }} role="tabpanel">
            <Typography variant="h5" component="h2" gutterBottom>
              {activeSection.label}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              {activeSection.description}
            </Typography>

            <SectionBody
              section={activeSection}
              readiness={readiness}
              settings={settings}
              settingsError={error}
              canWrite={canWrite}
              isSaving={isSaving}
              onSaveThemePolicy={saveThemePolicy}
              onNavigateToSection={goToSection}
            />
          </Box>
        </Paper>

        <Snackbar
          open={!!savedMessage}
          autoHideDuration={4000}
          onClose={() => setSavedMessage(null)}
          message={savedMessage}
        />

        <Snackbar
          open={!!saveError}
          autoHideDuration={6000}
          onClose={() => setSaveError(null)}
        >
          <Alert severity="error" onClose={() => setSaveError(null)}>
            {saveError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}

/**
 * Which section renders.
 *
 * A `planned` section short-circuits to `PlannedSectionPanel` BEFORE the
 * switch, so adding #350's component is a single case rather than an edit in
 * two places — and so a section whose status is flipped without a component
 * fails visibly here rather than rendering nothing.
 */
function SectionBody({
  section,
  readiness,
  settings,
  settingsError,
  canWrite,
  isSaving,
  onSaveThemePolicy,
  onNavigateToSection,
}: {
  section: ControlCenterSection;
  readiness: ReturnType<typeof useReadiness>;
  settings: ReturnType<typeof useSystemSettings>['settings'];
  settingsError: string | null;
  canWrite: boolean;
  isSaving: boolean;
  onSaveThemePolicy: (allowUserThemeOverride: boolean) => Promise<void>;
  onNavigateToSection: (key: ControlCenterSectionKey) => void;
}) {
  if (section.status === 'planned') {
    return <PlannedSectionPanel section={section} />;
  }

  switch (section.key) {
    case 'readiness':
      return (
        <ReadinessSection
          steps={readiness.steps}
          summary={readiness.summary}
          isLoading={readiness.isLoading}
          isRefreshing={readiness.isRefreshing}
          lastUpdatedAt={readiness.lastUpdatedAt}
          onRefresh={() => void readiness.refresh()}
          onNavigateToSection={onNavigateToSection}
        />
      );
    case 'interface':
      if (!settings) {
        return (
          <Alert severity="error">
            {settingsError ?? 'System settings could not be read.'}
          </Alert>
        );
      }
      return (
        <InterfaceSection
          settings={settings}
          onSave={onSaveThemePolicy}
          disabled={!canWrite || isSaving}
          canWrite={canWrite}
        />
      );
    default:
      // Unreachable while every `live` section has a case above. Left as a
      // visible failure rather than a silent blank: a section flipped to
      // `live` without a component is a mistake worth seeing.
      return (
        <Alert severity="warning">
          {section.label} is marked live but has no component yet.
        </Alert>
      );
  }
}
