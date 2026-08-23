/**
 * The one place a `ResourceState` becomes a panel body.
 *
 * Epic #19. Three dashboard panels (attention, queue, activity) all have the
 * same five-way decision to make, and the point of centralising it is not code
 * volume — it is that the `unwired` / `empty` distinction cannot be got right
 * in one panel and wrong in another. Every panel routes through this switch, so
 * the honesty rules are enforced structurally rather than by review.
 *
 * The mapping, and why each branch looks the way it does:
 *
 * | state     | body                | why                                        |
 * |-----------|---------------------|--------------------------------------------|
 * | `unwired` | `unwiredContent`    | recessive, names a roadmap phase            |
 * | `loading` | spinner             | ONLY before the first response, never after |
 * | `error`   | error alert         | reached only with no data to fall back on   |
 * | `empty`   | `emptyContent`      | a real finding — confident, not greyed out  |
 * | `ready`   | `children`          | plus a stale banner if `error` is set       |
 *
 * ## Two things this deliberately does not do
 *
 * **No shimmer skeleton.** A skeleton is a promise that content arrives in a
 * moment. On a panel whose endpoint arrives in Phase 3 that promise is a lie,
 * and a component cannot tell from `state` alone which kind of wait it is in —
 * so the honest spinner is used for the only wait that is genuinely short (the
 * first response from an endpoint that exists).
 *
 * **A failed re-poll never blanks the panel.** `usePolledResource` keeps stale
 * data alongside the error, so `state` is still `ready`; this component shows
 * the last known rows WITH a warning above them rather than replacing them
 * with an error. An operator mid-triage does not lose the screen they were
 * reading because one request timed out.
 */

import type { ReactNode } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CardHeader,
  Typography,
} from '@mui/material';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { ResourceState } from '../../hooks/usePolledResource';

export interface PanelCardProps {
  title: string;
  subtitle?: string;
  /** Header-right slot: a link to the full page, a filter, a refresh. */
  action?: ReactNode;
  state: ResourceState;
  /** Set after any failure — including one that left stale `children` usable. */
  error?: string | null;
  /** Rendered for `empty`. Should be an `EmptyState`. */
  emptyContent: ReactNode;
  /** Rendered for `unwired`. Should be a `NotWiredState`. */
  unwiredContent: ReactNode;
  /** Rendered for `ready`. */
  children?: ReactNode;
}

export function PanelCard({
  title,
  subtitle,
  action,
  state,
  error,
  emptyContent,
  unwiredContent,
  children,
}: PanelCardProps) {
  const body = (() => {
    switch (state) {
      case 'unwired':
        return unwiredContent;
      case 'loading':
        return <LoadingSpinner />;
      case 'error':
        // Only reachable with NO data at all — with data the state is `ready`
        // and the failure is reported as the stale banner below instead.
        return (
          <Alert severity="error" role="alert">
            {error ?? 'Could not load this panel.'}
          </Alert>
        );
      case 'empty':
        return emptyContent;
      case 'ready':
      default:
        return children;
    }
  })();

  const showStaleBanner =
    error !== null &&
    error !== undefined &&
    (state === 'ready' || state === 'empty');

  return (
    <Card
      component="section"
      // The panel's own title names the landmark, so the region is
      // navigable without inventing a second, differently-worded label.
      aria-labelledby={`${title.replace(/\s+/g, '-').toLowerCase()}-panel-title`}
      sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <CardHeader
        title={
          <Typography
            id={`${title.replace(/\s+/g, '-').toLowerCase()}-panel-title`}
            variant="h6"
            component="h2"
          >
            {title}
          </Typography>
        }
        subheader={
          subtitle ? (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          ) : undefined
        }
        action={action}
        sx={{ pb: 0 }}
      />

      <CardContent
        sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {showStaleBanner && (
          // `warning`, not `error`: what is on screen is still true, it is just
          // older than it should be. Calling that an error would train the
          // operator to ignore the red one.
          <Alert severity="warning" role="status" sx={{ mb: 0 }}>
            Showing the last known data — refresh failed: {error}
          </Alert>
        )}
        <Box sx={{ flexGrow: 1 }}>{body}</Box>
      </CardContent>
    </Card>
  );
}

export default PanelCard;
