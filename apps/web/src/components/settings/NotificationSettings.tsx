/**
 * Settings → Phone notifications (epic #17, issue #58).
 *
 * The last link in the chain VISION §1 complains about. Everything upstream
 * can work perfectly — the watchdog notices a stall in ninety seconds, the
 * escalation is recorded, the cockpit shows it — and detection latency is
 * still measured in hours if nobody is actually told.
 *
 * Two things this card is careful about:
 *
 *  1. **It never offers a button that would silently do nothing.** When the
 *     server has no VAPID keys, or the page is on plain HTTP, or the browser
 *     has no Push API, it says which — because those four situations have
 *     four different remedies, and "notifications unavailable" sends the
 *     operator to fix the wrong one.
 *  2. **It shows failing devices.** A subscription with a non-zero failure
 *     count is a phone that is not going to ring, and hiding that is the same
 *     class of problem as not sending at all.
 */

import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';

import { usePushNotifications, type PushUnsupportedReason } from '../../hooks/usePushNotifications';
import { LoadingSpinner } from '../common/LoadingSpinner';

/**
 * What to tell the operator, and what they can do about it.
 *
 * Written per reason rather than as one sentence with a variable in it: the
 * remedies are genuinely unrelated — a server environment variable, a TLS
 * certificate, a different browser, a browser setting — and only one of them
 * is something the person reading this can act on right now.
 */
const UNSUPPORTED_MESSAGE: Record<PushUnsupportedReason, string> = {
  'insecure-context':
    'Push notifications need HTTPS. This page is not on a secure origin, so the browser will ' +
    'not allow a subscription.',
  browser:
    'This browser has no Push API. On iOS, add the app to your home screen first — Safari only ' +
    'allows push from an installed web app.',
  server:
    'This server has no push keys configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, ' +
    'VAPID_SUBJECT). Until they are set, no escalation can reach a phone.',
  'permission-denied':
    'You denied notification permission for this site. Only you can undo that, in your ' +
    "browser's site settings — the page cannot ask again.",
};

export function NotificationSettings() {
  const {
    config,
    subscriptions,
    currentEndpoint,
    isSubscribed,
    isLoading,
    isBusy,
    error,
    unsupportedReason,
    subscribe,
    unsubscribe,
    remove,
  } = usePushNotifications();

  if (isLoading) return <LoadingSpinner />;

  return (
    <Card id="notifications">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Phone notifications
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Where Opifex reaches you when a run stalls, loops, or hits a ceiling. Each notification
          carries what happened, why, what it affects, and what happens if you ignore it.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {unsupportedReason ? (
          <Alert severity="warning">{UNSUPPORTED_MESSAGE[unsupportedReason]}</Alert>
        ) : (
          <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: 'center' }}>
            <Button
              variant={isSubscribed ? 'outlined' : 'contained'}
              color={isSubscribed ? 'inherit' : 'primary'}
              startIcon={
                isBusy ? (
                  <CircularProgress size={16} color="inherit" />
                ) : isSubscribed ? (
                  <NotificationsOffIcon />
                ) : (
                  <NotificationsActiveIcon />
                )
              }
              disabled={isBusy}
              onClick={() => void (isSubscribed ? unsubscribe() : subscribe())}
            >
              {isSubscribed ? 'Stop notifying this device' : 'Notify this device'}
            </Button>
            {isSubscribed && (
              <Typography variant="body2" color="success.main">
                This device will be notified.
              </Typography>
            )}
          </Stack>
        )}

        {config && !config.fallbackConfigured && (
          // Not an error: a single well-behaved phone is a working setup. It
          // is worth SAYING, though, because the day the phone is the thing
          // that breaks is the day the operator wishes they had known.
          <Alert severity="info" sx={{ mb: 2 }}>
            No fallback path is configured. If push delivery fails, the escalation is recorded as
            failed and stays visible in the cockpit — but nothing else will try to reach you. Set{' '}
            <code>NOTIFY_FALLBACK_WEBHOOK_URL</code> to add a second path.
          </Alert>
        )}

        <Typography variant="subtitle2" sx={{ mt: 2 }}>
          Registered devices
        </Typography>

        {subscriptions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No devices are subscribed. Every escalation will stop at the cockpit.
          </Typography>
        ) : (
          <List dense>
            {subscriptions.map((subscription) => (
              <ListItem
                key={subscription.id}
                secondaryAction={
                  <Tooltip title="Remove this device">
                    <span>
                      <IconButton
                        edge="end"
                        aria-label={`Remove device ${subscription.id}`}
                        disabled={isBusy}
                        onClick={() => void remove(subscription.id)}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                }
              >
                <ListItemText
                  primary={
                    <Box component="span" sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      {subscription.userAgent ?? 'Unknown device'}
                      {subscription.endpoint === currentEndpoint && (
                        <Chip size="small" label="This device" color="primary" />
                      )}
                      {subscription.failureCount > 0 && (
                        <Chip
                          size="small"
                          color="warning"
                          label={`${subscription.failureCount} failed delivery attempt(s)`}
                        />
                      )}
                    </Box>
                  }
                  secondary={
                    subscription.lastSuccessAt
                      ? `Last reached ${new Date(subscription.lastSuccessAt).toLocaleString()}`
                      : 'Never successfully notified'
                  }
                />
              </ListItem>
            ))}
          </List>
        )}
      </CardContent>
    </Card>
  );
}
