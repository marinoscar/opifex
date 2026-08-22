/**
 * Component tests — Settings → Phone notifications (#58).
 *
 * The card's job is to never lie about whether the operator can be reached.
 * Everything asserted here is a case where a plausible-looking UI would be
 * silently wrong: a button that cannot work, a "subscribed" badge earned by a
 * different device, a failing phone shown as healthy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { NotificationSettings } from '../../../components/settings/NotificationSettings';
import * as hook from '../../../hooks/usePushNotifications';
import type { UsePushNotificationsResult } from '../../../hooks/usePushNotifications';

function hookResult(overrides: Partial<UsePushNotificationsResult> = {}) {
  return {
    config: { vapidPublicKey: 'pub', pushConfigured: true, fallbackConfigured: true },
    subscriptions: [],
    currentEndpoint: null,
    isSubscribed: false,
    isLoading: false,
    isBusy: false,
    error: null,
    unsupportedReason: null,
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies UsePushNotificationsResult;
}

function device(overrides = {}) {
  return {
    id: 'sub-1',
    endpoint: 'https://push.example/abc',
    userAgent: 'iPhone',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('NotificationSettings', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(hook, 'usePushNotifications');
  });

  afterEach(() => vi.restoreAllMocks());

  describe('never offering a button that cannot work', () => {
    it.each([
      ['server', 'VAPID_PUBLIC_KEY'],
      ['insecure-context', 'HTTPS'],
      ['browser', 'home screen'],
      ['permission-denied', 'site settings'],
    ] as const)('explains %s with its own remedy', async (reason, phrase) => {
      // Four situations, four unrelated fixes — a server environment
      // variable, a TLS certificate, a different browser, a browser setting.
      // "Notifications unavailable" sends the operator to fix the wrong one.
      spy.mockReturnValue(hookResult({ unsupportedReason: reason }));

      render(<NotificationSettings />);

      expect(await screen.findByText(new RegExp(phrase, 'i'))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /notify this device/i })).toBeNull();
    });
  });

  describe('the subscribe control', () => {
    it('offers to subscribe when nothing is wrong', async () => {
      spy.mockReturnValue(hookResult());

      render(<NotificationSettings />);

      expect(screen.getByRole('button', { name: /notify this device/i })).toBeEnabled();
    });

    it('offers to STOP when this device is already subscribed', async () => {
      spy.mockReturnValue(hookResult({ isSubscribed: true, currentEndpoint: 'e' }));

      render(<NotificationSettings />);

      expect(screen.getByRole('button', { name: /stop notifying this device/i })).toBeInTheDocument();
    });

    it('calls subscribe when pressed', async () => {
      const result = hookResult();
      spy.mockReturnValue(result);

      render(<NotificationSettings />);
      await userEvent.click(screen.getByRole('button', { name: /notify this device/i }));

      await waitFor(() => expect(result.subscribe).toHaveBeenCalled());
    });

    it('is disabled while a request is in flight', async () => {
      spy.mockReturnValue(hookResult({ isBusy: true }));

      render(<NotificationSettings />);

      expect(screen.getByRole('button', { name: /notify this device/i })).toBeDisabled();
    });
  });

  describe('what it says about the devices', () => {
    it('says plainly when there are none', async () => {
      // "Every escalation will stop at the cockpit" is the consequence, and
      // it is the part an operator needs to read.
      spy.mockReturnValue(hookResult());

      render(<NotificationSettings />);

      expect(screen.getByText(/no devices are subscribed/i)).toBeInTheDocument();
    });

    it('marks which one is THIS device', async () => {
      spy.mockReturnValue(
        hookResult({
          subscriptions: [device(), device({ id: 'sub-2', endpoint: 'https://push.example/other' })],
          currentEndpoint: 'https://push.example/abc',
        }),
      );

      render(<NotificationSettings />);

      expect(screen.getByText('This device')).toBeInTheDocument();
    });

    it('shows a failing device as failing', async () => {
      // A subscription with a non-zero failure count is a phone that is not
      // going to ring. Hiding that is the same class of problem as not
      // sending at all.
      spy.mockReturnValue(hookResult({ subscriptions: [device({ failureCount: 3 })] }));

      render(<NotificationSettings />);

      expect(screen.getByText(/3 failed delivery attempt/i)).toBeInTheDocument();
    });

    it('distinguishes never-reached from last-reached', async () => {
      spy.mockReturnValue(hookResult({ subscriptions: [device()] }));

      render(<NotificationSettings />);

      expect(screen.getByText(/never successfully notified/i)).toBeInTheDocument();
    });

    it('removes a device when asked', async () => {
      const result = hookResult({ subscriptions: [device()] });
      spy.mockReturnValue(result);

      render(<NotificationSettings />);
      await userEvent.click(screen.getByRole('button', { name: /remove device sub-1/i }));

      await waitFor(() => expect(result.remove).toHaveBeenCalledWith('sub-1'));
    });
  });

  describe('the fallback path', () => {
    it('says when there is no second path', async () => {
      // Not an error — a single well-behaved phone is a working setup. Worth
      // SAYING, because the day the phone is the thing that breaks is the day
      // the operator wishes they had known.
      spy.mockReturnValue(
        hookResult({ config: { vapidPublicKey: 'p', pushConfigured: true, fallbackConfigured: false } }),
      );

      render(<NotificationSettings />);

      expect(screen.getByText(/no fallback path is configured/i)).toBeInTheDocument();
    });

    it('stays quiet when one exists', async () => {
      spy.mockReturnValue(hookResult());

      render(<NotificationSettings />);

      expect(screen.queryByText(/no fallback path is configured/i)).toBeNull();
    });
  });

  it('surfaces an error rather than failing silently', async () => {
    spy.mockReturnValue(hookResult({ error: 'Server said no' }));

    render(<NotificationSettings />);

    expect(screen.getByText('Server said no')).toBeInTheDocument();
  });
});
