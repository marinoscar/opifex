/**
 * Real `claude setup-token` output, captured through a real pty (#386).
 *
 * ## Captured, never written by hand
 *
 * Every string below came out of `claude` 2.1.246 running under
 * `script -qec "…" /dev/null` inside the API container, spawned from a Node
 * parent with no TTY of its own — the API's exact situation. They were dumped
 * as base64 and decoded straight into this file, so nothing has been tidied.
 *
 * That matters more than it sounds. A hand-written "clean" sample would have
 * spaces between words; this CLI emits none. It renders through Ink, which
 * positions each word with a cursor-column escape instead:
 *
 *     Welcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode
 *
 * A stripper that deletes escapes and keeps the text produces
 * `WelcometoClaudeCode`, and every phrase match against it fails. Only a
 * sample with the real escapes in it can catch that, which is why these are
 * here rather than invented.
 *
 * The other thing only a real capture shows is the WRAPPING, and it is why
 * `claude-auth.service.ts` widens the pty before it starts the CLI. See
 * {@link SETUP_TOKEN_URL_80_COLS} against {@link SETUP_TOKEN_URL_WIDE}.
 */

/**
 * The default 80-column pty: the URL is torn into five wrapped pieces.
 *
 * The visible text is unusable — `…client_id=9d1c250a-e61b-44d9-88` then a
 * newline then `ed-5944d1962f5e&response_type=…`. Reassembling it would mean
 * guessing which line breaks are soft and which are real.
 *
 * What saves it is that Ink wraps each fragment in an OSC 8 hyperlink whose
 * TARGET is the whole, unbroken URL, repeated once per fragment. So the
 * extractor reads the target and ignores the visible text entirely, and this
 * fixture is what proves it does.
 */
export const SETUP_TOKEN_URL_80_COLS =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[?2031hWelcome\u001b[9Gto\u001b[12GClaude\u001b[19GCode\u001b[24Gv2.1.246\r\r\n\r\r\n\u001b[2GThis\u001b[7Gwill\u001b[12Gguide\u001b[18Gyou\u001b[22Gthrough\u001b[30Glong-lived\u001b[41G(1-year)\u001b[50Gauth\u001b[55Gtoken\u001b[61Gsetup\u001b[67Gfor\u001b[71Gyour\r\r\n\u001b[2GClaude\u001b[9Gaccount.\u001b[18GClaude\u001b[25Gsubscription\u001b[38Grequired.\r\r\n\r\r\n\u001b[2GBrowser\u001b[10Gdidn't\u001b[17Gopen?\u001b[23GUse\u001b[27Gthe\u001b[31Gurl\u001b[35Gbelow\u001b[41Gto\u001b[44Gsign\u001b[49Gin\u001b[52G(c\u001b[55Gto\u001b[58Gcopy)\r\r\n\r\r\n\u001b]8;id=vsrnsk;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u0007https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\u001b]8;;\u0007\r\r\n\u001b]8;id=vsrnsk;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u0007ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\u001b]8;;\u0007\r\r\n\u001b]8;id=vsrnsk;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u0007m%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwl\u001b]8;;\u0007\r\r\n\u001b]8;id=vsrnsk;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u0007Q7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6n\u001b]8;;\u0007\r\r\n\u001b]8;id=vsrnsk;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=CHRgJqa2WYeZwlQ7bimH1PniAS-EBWAxcUbL6DvMCbo&code_challenge_method=S256&state=K0oMnVkBXFsoaiu6nHZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u0007HZ4zjHX-Ixtm4TkjQyPc4_Hhuk\u001b]8;;\u0007\r\r\n\r\r\n\r\r\n\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[18Gif\u001b[21Gprompted\u001b[30G>\r\r\n\u001b[>0q\u001b[c";

/**
 * The same moment with the pty widened to 400 columns, which is what the
 * service actually does.
 *
 * The URL is on one line, and the OSC 8 target and the visible text agree.
 * This is the case that matters for the TOKEN: the token is printed as plain
 * text with no hyperlink to fall back on, so if it wrapped there would be
 * nothing to reassemble it from. Widening the pty is therefore not a tidiness
 * measure — it is the thing that makes the success path parseable at all.
 */
export const SETUP_TOKEN_URL_WIDE =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[?2031hWelcome\u001b[9Gto\u001b[12GClaude\u001b[19GCode\u001b[24Gv2.1.246\r\r\n..........................................................\r\r\n\r\r\n\u001b[6G*\u001b[46G█████▓▓░\r\r\n\u001b[34G*\u001b[44G███▓░\u001b[54G░░\r\r\n\u001b[13G░░░░░░\u001b[43G███▓░\r\r\n\u001b[5G░░░\u001b[11G░░░░░░░░░░\u001b[43G███▓░\r\r\n\u001b[4G░░░░░░░░░░░░░░░░░░░\u001b[27G*\u001b[44G██▓░░\u001b[55G▓\r\r\n\u001b[46G░▓▓███▓▓░\r\r\n\u001b[2G*\u001b[36G░░░░\r\r\n\u001b[34G░░░░░░░░\r\r\n\u001b[32G░░░░░░░░░░░░░░░░\r\r\n\u001b[8G█████████\u001b[57G*\r\r\n\u001b[7G██▄█████▄██\u001b[42G*\r\r\n\u001b[8G█████████\u001b[23G*\r\r\n.......█\u001b[10G█\u001b[14G█\u001b[16G█..........................................\r\r\n\r\r\n\u001b[2GThis\u001b[7Gwill\u001b[12Gguide\u001b[18Gyou\u001b[22Gthrough\u001b[30Glong-lived\u001b[41G(1-year)\u001b[50Gauth\u001b[55Gtoken\u001b[61Gsetup\u001b[67Gfor\u001b[71Gyour\u001b[76GClaude\u001b[83Gaccount.\u001b[92GClaude\u001b[99Gsubscription\u001b[112Grequired.\r\r\n\r\r\n\u001b[2GBrowser\u001b[10Gdidn't\u001b[17Gopen?\u001b[23GUse\u001b[27Gthe\u001b[31Gurl\u001b[35Gbelow\u001b[41Gto\u001b[44Gsign\u001b[49Gin\u001b[52G(c\u001b[55Gto\u001b[58Gcopy)\r\r\n\r\r\n\u001b]8;id=9bj4zp;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=oamLzBGD2e0Sb5DbpocZzmuNUB_stkm_J-vIAMw55rk&code_challenge_method=S256&state=qS2qfk9FJVHZRfk5FWb2I9lYnzrpUWSNmxZpaF2p_TQ\u0007https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=oamLzBGD2e0Sb5DbpocZzmuNUB_stkm_J-vIAMw55rk&code_challenge_method=S256&state=qS2qfk9FJVHZRfk5FWb2I9lYnzrpUWSNmxZpaF2p_TQ\u001b]8;;\u0007\r\r\n\r\r\n\r\r\n\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[18Gif\u001b[21Gprompted\u001b[30G>\r\r\n\u001b[>0q\u001b[c";

/**
 * What a WRONG code looks like: captured by pasting `not-a-real-code#abcdef`.
 *
 * Three facts here that no invented sample would have contained:
 *
 *  1. The CLI does not exit. It prints `Press Enter to retry.` and keeps the
 *     pty open, so a caller waiting for a non-zero exit code waits forever.
 *  2. It redraws over its own output, so `Request` arrives as
 *     `Requ\x1b[20Gst` — the `e` is overwritten. Matching the literal phrase
 *     "Request failed" would not fire. The classifier keys off `OAuth error`
 *     and `status code 400` instead.
 *  3. The submitted code is echoed masked (`****************abcdef`), which is
 *     the CLI's own doing and not ours.
 */
export const SETUP_TOKEN_INVALID_CODE =
  '\n\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[18Gif\u001b[21Gprompted\u001b[30G>\r\r\n\u001b[>0q\u001b[c\r\u001b[31C\u001b[1A****************abcdef\r\r\n\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G\u001b[1A\r\u001b[1C\u001b[4AOAuth error: Requ\u001b[20Gst\u001b[23Gfailed with\u001b[35Gstatus code 400\u001b[K\r\u001b[2B\u001b[K\r\u001b[1B Press Enter to retry.\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[1B\u001b[K\r\u001b[5A';
