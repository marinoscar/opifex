import type { LoggerService } from '@nestjs/common';
import {
  GOOGLE_OAUTH_ENV,
  GoogleOAuthConfigReader,
  googleOAuthUnavailableMessage,
  isGoogleOAuthConfigured,
  logGoogleOAuthStatus,
  readGoogleOAuthStatus,
} from './google-oauth.config';

function reader(values: Record<string, string>): GoogleOAuthConfigReader {
  return {
    get: <T = string>(key: string) => values[key] as T | undefined,
  };
}

function fakeLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService & {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
}

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret';
const CALLBACK = 'http://localhost:3535/api/auth/google/callback';

describe('readGoogleOAuthStatus', () => {
  it('is configured when both credentials and the callback URL are set', () => {
    const status = readGoogleOAuthStatus(
      reader({
        'google.clientId': CLIENT_ID,
        'google.clientSecret': CLIENT_SECRET,
        'google.callbackUrl': CALLBACK,
      }),
    );

    expect(status).toEqual({
      kind: 'configured',
      options: {
        clientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        callbackURL: CALLBACK,
      },
      missing: [],
    });
    expect(isGoogleOAuthConfigured(status)).toBe(true);
  });

  it('is configured without a callback URL, and reports it as missing', () => {
    // The credential pair is the gate; the callback URL is optional because
    // passport omits `redirect_uri` when it is absent and Google falls back to
    // the URI registered on the OAuth client. `undefined`, never `''` — an
    // empty redirect_uri is rejected by Google.
    const status = readGoogleOAuthStatus(
      reader({
        'google.clientId': CLIENT_ID,
        'google.clientSecret': CLIENT_SECRET,
      }),
    );

    expect(status.kind).toBe('configured');
    expect(status).toMatchObject({
      options: { callbackURL: undefined },
      missing: [GOOGLE_OAUTH_ENV.callbackUrl],
    });
  });

  it('is absent when nothing at all is set', () => {
    expect(readGoogleOAuthStatus(reader({}))).toEqual({ kind: 'absent' });
  });

  it('is absent when every variable is an empty string', () => {
    // `''` is what the old `|| ''` fallback supplied and exactly what
    // passport-oauth2 rejects, so it must not read as "configured" (#138).
    expect(
      readGoogleOAuthStatus(
        reader({
          'google.clientId': '',
          'google.clientSecret': '   ',
          'google.callbackUrl': '',
        }),
      ),
    ).toEqual({ kind: 'absent' });
  });

  it.each([
    ['client id only', { 'google.clientId': CLIENT_ID }],
    ['client secret only', { 'google.clientSecret': CLIENT_SECRET }],
    ['callback URL only', { 'google.callbackUrl': CALLBACK }],
  ])('is partial with the %s set', (_label, values) => {
    const status = readGoogleOAuthStatus(reader(values));

    expect(status.kind).toBe('partial');
    expect(isGoogleOAuthConfigured(status)).toBe(false);
  });

  it('names exactly the variables that are missing when partial', () => {
    const status = readGoogleOAuthStatus(
      reader({ 'google.clientId': CLIENT_ID }),
    );

    expect(status).toEqual({
      kind: 'partial',
      missing: [GOOGLE_OAUTH_ENV.clientSecret, GOOGLE_OAUTH_ENV.callbackUrl],
    });
  });
});

describe('googleOAuthUnavailableMessage', () => {
  it('names both credentials when nothing is configured', () => {
    const message = googleOAuthUnavailableMessage({ kind: 'absent' });

    expect(message).toContain(GOOGLE_OAUTH_ENV.clientId);
    expect(message).toContain(GOOGLE_OAUTH_ENV.clientSecret);
    expect(message).toContain('/api/auth/providers');
  });

  it('names only the missing credential when half-configured', () => {
    const status = readGoogleOAuthStatus(
      reader({ 'google.clientId': CLIENT_ID }),
    );
    const message = googleOAuthUnavailableMessage(status);

    expect(message).toContain(GOOGLE_OAUTH_ENV.clientSecret);
    expect(message).not.toContain(GOOGLE_OAUTH_ENV.clientId);
    // The callback URL is not what makes it unavailable, so naming it here
    // would send the operator after the wrong variable.
    expect(message).not.toContain(GOOGLE_OAUTH_ENV.callbackUrl);
  });
});

describe('logGoogleOAuthStatus', () => {
  it('does not warn when nothing is configured', () => {
    // A deployment that deliberately runs headless is a supported way to run
    // this (#138). It gets one informational line and is not nagged.
    const logger = fakeLogger();

    logGoogleOAuthStatus({ kind: 'absent' }, logger);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toContain(GOOGLE_OAUTH_ENV.clientId);
  });

  it('warns when the configuration is half-finished', () => {
    // The operator who believes they configured OAuth and did not. This is the
    // one case that must be loud, and it must name the variable.
    const logger = fakeLogger();

    logGoogleOAuthStatus(
      readGoogleOAuthStatus(reader({ 'google.clientId': CLIENT_ID })),
      logger,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      GOOGLE_OAUTH_ENV.clientSecret,
    );
  });

  it('warns when enabled without a callback URL, and still reports enabled', () => {
    const logger = fakeLogger();

    logGoogleOAuthStatus(
      readGoogleOAuthStatus(
        reader({
          'google.clientId': CLIENT_ID,
          'google.clientSecret': CLIENT_SECRET,
        }),
      ),
      logger,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      GOOGLE_OAUTH_ENV.callbackUrl,
    );
    expect(logger.log).toHaveBeenCalledWith('Google login is enabled');
  });

  it('is quiet when fully configured', () => {
    const logger = fakeLogger();

    logGoogleOAuthStatus(
      readGoogleOAuthStatus(
        reader({
          'google.clientId': CLIENT_ID,
          'google.clientSecret': CLIENT_SECRET,
          'google.callbackUrl': CALLBACK,
        }),
      ),
      logger,
    );

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
