import { useCallback, useEffect, useState } from 'react';

import {
  createPushSubscription,
  deletePushSubscription,
  getNotificationConfig,
  getPushSubscriptions,
} from '../services/api';
import type { NotificationConfig, PushSubscriptionRecord } from '../types';
import { useIsMounted } from './useIsMounted';

/** Where the service worker lives. Fixed, because a worker is fetched by URL. */
export const SERVICE_WORKER_URL = '/notification-sw.js';

/**
 * Why this browser cannot be notified, when it cannot.
 *
 * An enum rather than a boolean, because the four cases have four different
 * remedies and telling the operator only "notifications unavailable" leaves
 * them to guess which. Getting this wrong means the person who most needs the
 * notification quietly does not get one.
 */
export type PushUnsupportedReason =
  /** No Push API — Safari before 16.4, or a browser in a stripped-down mode. */
  | 'browser'
  /** Not a secure context. Push requires HTTPS (localhost excepted). */
  | 'insecure-context'
  /** The server has no VAPID keys, so a subscription could never be used. */
  | 'server'
  /** The user denied permission, which only they can undo in browser settings. */
  | 'permission-denied';

export interface UsePushNotificationsResult {
  config: NotificationConfig | null;
  subscriptions: PushSubscriptionRecord[];
  /** This browser's own subscription, if it has one. */
  currentEndpoint: string | null;
  isSubscribed: boolean;
  isLoading: boolean;
  isBusy: boolean;
  error: string | null;
  unsupportedReason: PushUnsupportedReason | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePushNotifications(): UsePushNotificationsResult {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionRecord[]>(
    [],
  );
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, list] = await Promise.all([
        getNotificationConfig(),
        getPushSubscriptions(),
      ]);
      if (!isMounted()) return;
      setConfig(nextConfig);
      setSubscriptions(list.items);
      setError(null);
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to load notification settings',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ask the browser what it already has, rather than inferring from the server
  // list. The server knows every device the ACCOUNT has registered; only the
  // browser knows whether THIS one is among them, and showing "subscribed"
  // because a different phone is would be the worst possible lie here.
  useEffect(() => {
    if (!browserSupportsPush()) return;

    void navigator.serviceWorker
      .getRegistration(SERVICE_WORKER_URL)
      .then(async (registration) => {
        const existing = await registration?.pushManager.getSubscription();
        if (isMounted()) setCurrentEndpoint(existing?.endpoint ?? null);
      });
  }, [isMounted]);

  const subscribe = useCallback(async () => {
    if (!config?.vapidPublicKey) {
      setError('This server has no push keys configured');
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        // Not an error to retry: only the user can undo a denial, and only in
        // browser settings. Saying so is more use than a failed button.
        if (isMounted()) setPermissionDenied(permission === 'denied');
        return;
      }

      const registration =
        await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      // `ready` rather than the register() result: a worker that is installed
      // but not yet active cannot receive a push, and subscribing before it is
      // would register a device that silently drops the first notification.
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Required by every browser: a push that cannot be shown to the user
        // is not allowed, which is exactly the guarantee this feature needs.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });

      const json = subscription.toJSON();
      await createPushSubscription({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        userAgent: navigator.userAgent.slice(0, 512),
      });

      if (isMounted()) {
        setCurrentEndpoint(subscription.endpoint);
        setPermissionDenied(false);
      }
      await refresh();
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error ? err.message : 'Failed to enable notifications',
        );
      }
    } finally {
      if (isMounted()) setIsBusy(false);
    }
  }, [config, isMounted, refresh]);

  const unsubscribe = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const registration =
        await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
      const subscription = await registration?.pushManager.getSubscription();
      const endpoint = subscription?.endpoint;

      await subscription?.unsubscribe();

      // Remove the SERVER's row too. Unsubscribing in the browser alone would
      // leave the control plane pushing to a dead endpoint until the push
      // service reported it gone — which is a stretch of time in which every
      // escalation counts a failure that is nobody's fault.
      const record = subscriptions.find((item) => item.endpoint === endpoint);
      if (record) await deletePushSubscription(record.id);

      if (isMounted()) setCurrentEndpoint(null);
      await refresh();
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to disable notifications',
        );
      }
    } finally {
      if (isMounted()) setIsBusy(false);
    }
  }, [isMounted, refresh, subscriptions]);

  const remove = useCallback(
    async (id: string) => {
      setIsBusy(true);
      setError(null);
      try {
        await deletePushSubscription(id);
        await refresh();
      } catch (err) {
        if (isMounted()) {
          setError(
            err instanceof Error ? err.message : 'Failed to remove the device',
          );
        }
      } finally {
        if (isMounted()) setIsBusy(false);
      }
    },
    [isMounted, refresh],
  );

  return {
    config,
    subscriptions,
    currentEndpoint,
    isSubscribed: currentEndpoint !== null,
    isLoading,
    isBusy,
    error,
    unsupportedReason: unsupportedReason(config, permissionDenied),
    subscribe,
    unsubscribe,
    remove,
    refresh,
  };
}

function unsupportedReason(
  config: NotificationConfig | null,
  permissionDenied: boolean,
): PushUnsupportedReason | null {
  // Order matters: report the FIRST thing the operator would have to fix.
  // Telling somebody on plain HTTP that their browser is unsupported sends
  // them to buy a different phone.
  if (typeof window !== 'undefined' && !window.isSecureContext)
    return 'insecure-context';
  if (!browserSupportsPush()) return 'browser';
  if (config && !config.pushConfigured) return 'server';
  if (permissionDenied) return 'permission-denied';
  return null;
}

export function browserSupportsPush(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * VAPID keys travel as base64url; `applicationServerKey` wants raw bytes.
 *
 * Written out rather than pulled from a library because it is nine lines and
 * a dependency here would be a supply-chain surface on the one code path that
 * decides whether an operator can be reached at all.
 */
export function urlBase64ToUint8Array(
  base64UrlKey: string,
): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlKey.length % 4)) % 4);
  const base64 = (base64UrlKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);

  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}
