import {
  SETUP_TOKEN_INVALID_CODE,
  SETUP_TOKEN_URL_80_COLS,
  SETUP_TOKEN_URL_WIDE,
} from './claude-cli-output.fixtures';
import {
  classifyFailure,
  describeFailure,
  extractAuthorizeUrl,
  extractOauthToken,
  isAwaitingCode,
  redactTokens,
  stripAnsi,
  CLAUDE_AUTH_FAILURE_REASONS,
} from './claude-cli-output';

/**
 * The parser, against REAL captured output (#386).
 *
 * Every assertion below that matters runs on a string that came out of
 * `claude` 2.1.246 on a real pty. That is the point of the file: a
 * hand-written sample of this CLI's output would have spaces between the
 * words, and the real one does not — it positions each word with a cursor
 * escape. A parser tested only against an invented sample passes here and
 * fails in production on the first click, which is precisely the failure this
 * spec is written to make impossible.
 */

const FULL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=' +
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=' +
  'https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=' +
  'user%3Ainference&code_challenge=' +
  'CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256' +
  '&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk';

describe('stripAnsi', () => {
  it('turns cursor positioning into the spaces the CLI meant by it', () => {
    // THE assertion this file exists for. The raw bytes are
    // `Welcome\x1b[9Gto\x1b[12GClaude…` with no space anywhere, and a
    // stripper that merely deletes escapes yields `WelcometoClaudeCode`.
    expect(stripAnsi(SETUP_TOKEN_URL_WIDE)).toContain(
      'Welcome to Claude Code v2.1.246',
    );
  });

  it('recovers the prompt the CLI blocks on, spaced correctly', () => {
    expect(stripAnsi(SETUP_TOKEN_URL_80_COLS)).toContain(
      'Paste code here if prompted >',
    );
  });

  it('leaves no escape or control byte behind', () => {
    for (const sample of [
      SETUP_TOKEN_URL_80_COLS,
      SETUP_TOKEN_URL_WIDE,
      SETUP_TOKEN_INVALID_CODE,
    ]) {
      // Newlines and ordinary spaces only. Anything else surviving means a
      // sequence shape this module does not know about, which is exactly how
      // a phrase match starts silently failing.
      // eslint-disable-next-line no-control-regex
      expect(stripAnsi(sample)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    }
  });

  it('keeps line structure rather than flattening to one blob', () => {
    expect(stripAnsi(SETUP_TOKEN_URL_WIDE).split('\n').length).toBeGreaterThan(
      3,
    );
  });
});

describe('extractAuthorizeUrl', () => {
  it('reassembles a URL the 80-column pty tore into five wrapped pieces', () => {
    // The visible text in this capture reads
    // `…client_id=9d1c250a-e61b-44d9-88` / newline / `ed-5944d1962f5e&…`.
    // Only the OSC 8 target survives intact, and this proves the extractor
    // reads that rather than the text.
    expect(extractAuthorizeUrl(SETUP_TOKEN_URL_80_COLS)).toBe(FULL_URL);
  });

  it('does not return one of the wrapped fragments by mistake', () => {
    const url = extractAuthorizeUrl(SETUP_TOKEN_URL_80_COLS) ?? '';

    // The most likely wrong answer: the first visible chunk, which ends
    // mid-uuid and is a perfectly well-formed URL that goes nowhere useful.
    expect(url).not.toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88',
    );
    expect(url).toContain('state=');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('reads the wide-pty capture too, where nothing wrapped', () => {
    const url = extractAuthorizeUrl(SETUP_TOKEN_URL_WIDE);

    expect(url).toContain('code_challenge_method=S256');
    expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  });

  it('falls back to visible text when the terminal emitted no hyperlink', () => {
    // A terminal with OSC 8 disabled. Weaker — it can only return what is
    // visible — but better than refusing to start.
    const plain = 'Browser did not open? Use the url below\n' + FULL_URL + '\n';

    expect(extractAuthorizeUrl(plain)).toBe(FULL_URL);
  });

  it('answers null while the CLI is still starting up', () => {
    expect(extractAuthorizeUrl('Welcome to Claude Code v2.1.246\n')).toBeNull();
  });

  it('ignores a hyperlink that is not an authorize URL', () => {
    const other = '\x1b]8;id=x;https://example.com/docs\x07docs\x1b]8;;\x07';

    expect(extractAuthorizeUrl(other)).toBeNull();
  });
});

describe('isAwaitingCode', () => {
  it('is true on the real capture, where the prompt is escape-separated', () => {
    expect(isAwaitingCode(SETUP_TOKEN_URL_80_COLS)).toBe(true);
    expect(isAwaitingCode(SETUP_TOKEN_URL_WIDE)).toBe(true);
  });

  it('is false before the CLI has got that far', () => {
    expect(isAwaitingCode('Welcome to Claude Code v2.1.246\n')).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('calls a rejected code a rejected code, from the real capture', () => {
    // The capture is what the CLI actually printed for a deliberately bogus
    // code. Note it renders `Request` as `Requ\x1b[20Gst` — the `e` is
    // overwritten — so a classifier matching the literal phrase would miss.
    expect(classifyFailure(SETUP_TOKEN_INVALID_CODE)).toBe('invalid_code');
  });

  it('does not read the CLI banner as a missing subscription', () => {
    // THE trap. Every run of `claude setup-token`, including the ones that
    // succeed, prints "Claude subscription required." in its banner. A
    // classifier fed the whole transcript would report `no_subscription` for
    // a perfectly good account on every attempt, which is why the service
    // slices the buffer at the code-submission offset and why this asserts
    // the banner alone classifies as nothing.
    expect(stripAnsi(SETUP_TOKEN_URL_WIDE)).toContain(
      'Claude subscription required',
    );
    expect(classifyFailure(SETUP_TOKEN_URL_WIDE)).toBeNull();
  });

  it('recognises an account on hold ahead of the OAuth error it also emits', () => {
    // Both phrases present, as the CLI emits them together. The account is
    // the actionable fact; "OAuth error" would send the operator back to
    // re-copy a code that was never the problem.
    const onHold =
      'OAuth error: Request failed with status code 400\n' +
      "Your account is on hold and can't use Claude Code. View details or " +
      'appeal: https://claude.ai/restricted\n';

    expect(classifyFailure(onHold)).toBe('no_subscription');
  });

  it.each([
    ["The organization didn't grant inference access to this sign-in."],
    [
      'Your organization has disabled Claude subscription access for Claude Code',
    ],
    [
      'setup-token creates a long-lived Claude.ai subscription token, which ' +
        'this policy does not permit.',
    ],
  ])('reads %j as a subscription problem', (text) => {
    // All three are strings read out of the shipped `claude` 2.1.246 binary,
    // not invented. Each is a case where sign-in worked and the ACCOUNT is
    // what cannot mint a token.
    expect(classifyFailure(text)).toBe('no_subscription');
  });

  it('reads a shell "not found" as a missing CLI', () => {
    expect(classifyFailure('sh: claude: not found\n')).toBe('cli_missing');
  });

  it('answers null while the exchange is still in flight', () => {
    // Not a failure — the difference between "no news yet" and "failed", and
    // returning a reason here would abort a working exchange.
    expect(classifyFailure('Processing authentication…\n')).toBeNull();
  });
});

describe('extractOauthToken', () => {
  it('finds the token on the CLI success screen', () => {
    // Modelled on the real success screen, whose strings were read out of the
    // shipped binary: "Authentication token created successfully!",
    // "Your OAuth token (valid for …", "Store this token securely."
    const success =
      'Authentication\x1b[15Gtoken\x1b[21Gcreated\x1b[29Gsuccessfully!\r\r\n' +
      '\x1b[2GYour\x1b[7GOAuth\x1b[13Gtoken\x1b[19G(valid\x1b[26Gfor\x1b[30G1\x1b[32Gyear)\r\r\n' +
      'sk-ant-oat01-A1b2C3d4E5f6G7h8I9\r\r\n' +
      "\x1b[2GStore\x1b[8Gthis\x1b[13Gtoken\x1b[19Gsecurely.\x1b[29GYou\x1b[33Gwon't\x1b[39Gbe\x1b[42Gable\x1b[47Gto\x1b[50Gsee\x1b[54Git\x1b[57Gagain.\r\r\n";

    expect(extractOauthToken(success)).toBe('sk-ant-oat01-A1b2C3d4E5f6G7h8I9');
  });

  it('never splices the following line onto the token', () => {
    // The reason there is no de-wrapping fallback. `Store` is on the line
    // after the token and is made of token-alphabet characters, so any
    // newline-stripping rescue produces `…Y5z6Store` — longer, still
    // matching, and a credential that can never authenticate. It would seal
    // cleanly and turn the readiness step green while every dispatch failed
    // at auth. Failing to find a token is recoverable; sealing a corrupted
    // one is not.
    const success =
      'Your OAuth token (valid for 1 year)\r\r\n' +
      'sk-ant-oat01-A1b2C3d4E5f6G7h8I9\r\r\n' +
      'Store this token securely.\r\r\n';

    expect(extractOauthToken(success)).toBe('sk-ant-oat01-A1b2C3d4E5f6G7h8I9');
  });

  it('answers null for a token torn across lines rather than guessing', () => {
    // The documented, deliberate limitation: a narrow pty loses the token and
    // says so, instead of inventing one. The service widens the pty to 400
    // columns precisely so this stays hypothetical.
    const wrapped = 'sk-ant-oat01-A1b2C3d4\r\r\n' + 'E5f6G7h8I9\r\r\n';

    expect(extractOauthToken(wrapped)).toBeNull();
  });

  it('finds nothing in the pre-code output, which has no token in it', () => {
    expect(extractOauthToken(SETUP_TOKEN_URL_80_COLS)).toBeNull();
    expect(extractOauthToken(SETUP_TOKEN_INVALID_CODE)).toBeNull();
  });

  it('does not mistake prose about tokens for a token', () => {
    expect(
      extractOauthToken('Use this token by setting: export ' + 'sk-ant-short'),
    ).toBeNull();
  });
});

describe('redactTokens', () => {
  it('removes anything token-shaped from text about to leave the process', () => {
    const leaked = 'CLI said: sk-ant-oat01-A1b2C3d4E5f6G7h8I9 and exited';

    const safe = redactTokens(leaked);

    expect(safe).not.toContain('A1b2C3d4E5f6G7h8I9');
    expect(safe).toContain('sk-ant-[redacted]');
  });
});

describe('describeFailure', () => {
  it('says something different, and specific, for every reason', () => {
    const messages = CLAUDE_AUTH_FAILURE_REASONS.map(describeFailure);

    // Distinct: the acceptance criterion is that four causes get four
    // messages, and a switch whose arms had drifted into the same sentence
    // would satisfy "has a message" and fail the actual requirement.
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(30);
  });

  it('tells the operator what to DO, per cause', () => {
    expect(describeFailure('invalid_code')).toMatch(/single-use|expire/i);
    expect(describeFailure('no_subscription')).toMatch(/Pro, Max, Team/);
    expect(describeFailure('cli_missing')).toMatch(/binary/i);
    expect(describeFailure('pty_unavailable')).toMatch(/util-linux/);
    expect(describeFailure('timed_out')).toMatch(/Nothing was changed/);
  });
});
