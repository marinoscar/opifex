import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import {
  browserSupportsPush,
  urlBase64ToUint8Array,
  usePushNotifications,
} from '../../hooks/usePushNotifications';
import * as api from '../../services/api';
import type { NotificationConfig, PushSubscriptionRecord } from '../../types';

vi.mock('../../services/api', () => ({
  getNotificationConfig: vi.fn(),
  getPushSubscriptions: vi.fn(),
  createPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}));

const CONFIG: NotificationConfig = {
  vapidPublicKey:
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZwuiKmpBpMWvcxYVbGGmkTBBUuRQGSlxAOKmR1IQ',
  pushConfigured: true,
  fallbackConfigured: false,
};

const DEVICE: PushSubscriptionRecord = {
  id: 'sub-1',
  endpoint: 'https://push.example/abc',
  userAgent: 'iPhone',
  failureCount: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: new Date().toISOString(),
};

/** A browser that supports push and has no existing subscription. */
function stubBrowser(options: { existingEndpoint?: string | null } = {}) {
  const subscription = {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ keys: { p256dh: 'key', auth: 'secret' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };

  const existing = options.existingEndpoint
    ? { ...subscription, endpoint: options.existingEndpoint }
    : null;

  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existing),
      subscribe: vi.fn().mockResolvedValue(subscription),
    },
  };

  const serviceWorker = {
    register: vi.fn().mockResolvedValue(registration),
    getRegistration: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
  };

  vi.stubGlobal('navigator', {
    serviceWorker,
    userAgent: 'TestBrowser/1.0',
  });
  vi.stubGlobal('Notification', {
    requestPermission: vi.fn().mockResolvedValue('granted'),
  });
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
  (window as unknown as Record<string, unknown>).PushManager =
    function PushManager() {};
  (window as unknown as Record<string, unknown>).Notification =
    globalThis.Notification;

  return { serviceWorker, registration, subscription };
}

describe('usePushNotifications', () => {
  beforeEach(() => {
    vi.mocked(api.getNotificationConfig).mockResolvedValue(CONFIG);
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({
      items: [],
      total: 0,
    });
    vi.mocked(api.createPushSubscription).mockResolvedValue(DEVICE);
    vi.mocked(api.deletePushSubscription).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('why it cannot notify, when it cannot', () => {
    it('reports an insecure origin BEFORE blaming the browser', async () => {
      // Telling somebody on plain HTTP that their browser is unsupported
      // sends them to buy a different phone. Report the first thing they
      // would actually have to fix.
      stubBrowser();
      Object.defineProperty(window, 'isSecureContext', {
        value: false,
        configurable: true,
      });

      const { result } = renderHook(() => usePushNotifications());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.unsupportedReason).toBe('insecure-context');
    });

    it('reports a browser with no Push API', async () => {
      Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
      });
      vi.stubGlobal('navigator', { userAgent: 'Old/1.0' });
      delete (window as unknown as Record<string, unknown>).PushManager;

      const { result } = renderHook(() => usePushNotifications());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.unsupportedReason).toBe('browser');
    });

    it('reports a server with no keys, rather than offering a dead button', async () => {
      // A button that silently does nothing is the same failure as no
      // notification at all, dressed as a feature.
      stubBrowser();
      vi.mocked(api.getNotificationConfig).mockResolvedValue({
        ...CONFIG,
        pushConfigured: false,
        vapidPublicKey: '',
      });

      const { result } = renderHook(() => usePushNotifications());

      await waitFor(() =>
        expect(result.current.unsupportedReason).toBe('server'),
      );
    });

    it('reports a denied permission, which only the user can undo', async () => {
      stubBrowser();
      vi.stubGlobal('Notification', {
        requestPermission: vi.fn().mockResolvedValue('denied'),
      });

      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.subscribe();
      });

      expect(result.current.unsupportedReason).toBe('permission-denied');
    });

    it('says nothing is wrong when nothing is', async () => {
      stubBrowser();

      const { result } = renderHook(() => usePushNotifications());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.unsupportedReason).toBeNull();
    });
  });

  describe('subscribing', () => {
    it('registers the device with the server', async () => {
      stubBrowser();
      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.subscribe();
      });

      expect(api.createPushSubscription).toHaveBeenCalledWith({
        endpoint: 'https://push.example/abc',
        p256dh: 'key',
        auth: 'secret',
        userAgent: 'TestBrowser/1.0',
      });
    });

    it('requires the push be user-visible', async () => {
      // Every browser demands it, and it is exactly the guarantee this
      // feature needs: a push that cannot be shown to the user is useless
      // here.
      const { registration } = stubBrowser();
      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.subscribe();
      });

      expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ userVisibleOnly: true }),
      );
    });

    it('waits for the worker to be ACTIVE before subscribing', async () => {
      // A worker that is installed but not yet active cannot receive a push,
      // and subscribing before it is would register a device that silently
      // drops the first notification.
      const { serviceWorker, registration } = stubBrowser();
      let ready = false;
      Object.defineProperty(serviceWorker, 'ready', {
        get: () =>
          Promise.resolve(registration).then((r) => ((ready = true), r)),
      });

      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await act(async () => {
        await result.current.subscribe();
      });

      expect(ready).toBe(true);
      expect(registration.pushManager.subscribe).toHaveBeenCalled();
    });

    it('marks THIS browser subscribed, not the account', async () => {
      stubBrowser();
      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.subscribe();
      });

      expect(result.current.isSubscribed).toBe(true);
      expect(result.current.currentEndpoint).toBe('https://push.example/abc');
    });

    it('does not claim this browser is subscribed because another device is', async () => {
      // The server knows every device the ACCOUNT registered; only the
      // browser knows whether THIS one is among them. Showing "subscribed"
      // because a different phone is would be the worst possible lie here.
      stubBrowser({ existingEndpoint: null });
      vi.mocked(api.getPushSubscriptions).mockResolvedValue({
        items: [
          { ...DEVICE, endpoint: 'https://push.example/someone-elses-phone' },
        ],
        total: 1,
      });

      const { result } = renderHook(() => usePushNotifications());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.isSubscribed).toBe(false);
      expect(result.current.subscriptions).toHaveLength(1);
    });

    it('surfaces a failure instead of looking like it worked', async () => {
      stubBrowser();
      vi.mocked(api.createPushSubscription).mockRejectedValue(
        new Error('Server said no'),
      );

      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await act(async () => {
        await result.current.subscribe();
      });

      expect(result.current.error).toBe('Server said no');
      expect(result.current.isSubscribed).toBe(false);
    });
  });

  describe('unsubscribing', () => {
    it('removes the SERVER row as well as the browser subscription', async () => {
      // Unsubscribing in the browser alone would leave the control plane
      // pushing to a dead endpoint until the push service reported it gone —
      // a stretch of time in which every escalation counts a failure that is
      // nobody's fault.
      const { subscription } = stubBrowser({
        existingEndpoint: 'https://push.example/abc',
      });
      vi.mocked(api.getPushSubscriptions).mockResolvedValue({
        items: [DEVICE],
        total: 1,
      });

      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isSubscribed).toBe(true));

      await act(async () => {
        await result.current.unsubscribe();
      });

      expect(subscription.unsubscribe).toHaveBeenCalled();
      expect(api.deletePushSubscription).toHaveBeenCalledWith('sub-1');
      expect(result.current.isSubscribed).toBe(false);
    });
  });

  describe('removing another device', () => {
    it('deletes it and refreshes the list', async () => {
      stubBrowser();
      vi.mocked(api.getPushSubscriptions).mockResolvedValue({
        items: [DEVICE],
        total: 1,
      });

      const { result } = renderHook(() => usePushNotifications());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.remove('sub-1');
      });

      expect(api.deletePushSubscription).toHaveBeenCalledWith('sub-1');
      expect(api.getPushSubscriptions).toHaveBeenCalledTimes(2);
    });
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID key to raw bytes', () => {
    // `applicationServerKey` wants bytes; VAPID keys travel as base64url.
    const bytes = urlBase64ToUint8Array('AQAB');

    expect(Array.from(bytes)).toEqual([1, 0, 1]);
  });

  it('handles the url-safe alphabet, which plain atob does not', () => {
    // `-` and `_` stand in for `+` and `/`. Feeding them to atob unchanged
    // produces the wrong bytes silently, and the subscription then fails at
    // the push service with an error that names none of this.
    expect(Array.from(urlBase64ToUint8Array('-_8='))).toEqual([251, 255]);
  });

  it('restores the padding base64url strips', () => {
    expect(() => urlBase64ToUint8Array('AQA')).not.toThrow();
  });
});

describe('browserSupportsPush', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('needs all three of service workers, PushManager and Notification', () => {
    vi.stubGlobal('navigator', {});
    expect(browserSupportsPush()).toBe(false);
  });
});
