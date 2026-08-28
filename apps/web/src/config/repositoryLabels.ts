/**
 * How the observed label row is PRESENTED (#415).
 *
 * The ladder card shows CONFIGURED state — four flags somebody set. Label
 * presence is OBSERVED state: what GitHub had when somebody last looked. Epic
 * #332's first rule is that the two are never merged, so everything here is
 * built to keep an observation from reading as a stored fact:
 * `config/credentialProbes.ts` makes the same distinction for the Test
 * buttons, and this file follows it.
 *
 * ## The rule this file exists to enforce: a count needs a READ
 *
 * The API's seven count fields are `number | null`, null together, and **null
 * means the labels were never read — never that there are none**. `wasRead`
 * is the gate, and `countSentence` answers `null` rather than a zero for a
 * report that observed nothing, because "the repository has none of them" and
 * "nobody found out" are different facts with different remedies, and the
 * first sends an operator to create fifteen labels that may all already exist.
 *
 * ## The gate is a NULL check, not a `status` check
 *
 * This is the part that is easy to get subtly wrong, because the two
 * conditions agree on eight of nine statuses and then come apart on the case
 * that matters most:
 *
 *  - a **read-phase** failure never got the label list: counts null, `labels`
 *    empty, and no number about this repository can be honest;
 *  - a **write-phase** failure got the list and was then refused mid-write:
 *    `status` is still `refused`, and the counts are REAL — this call knows
 *    exactly what is on the repository and may have created some labels before
 *    being cut off.
 *
 * A gate keyed on `status ∈ {ok, incomplete}` blanks that second case, turning
 * a genuine observation into "we could not ask" and throwing away the count an
 * operator most wants. So `wasRead` reads the nulls themselves.
 *
 * ## The API's `detail` is quoted, never paraphrased
 *
 * Each presentation carries this build's `remedy`; the API's own sentence is
 * rendered verbatim beside it, because it knows things this build cannot —
 * which HTTP status GitHub returned, when the rate limit resets. The rule
 * `config/availableRepositories.ts` states, applied to the same kind of
 * answer.
 *
 * ## Repair is offered only where pressing it could change something
 *
 * That decision is made from `status`, and correctly so: `status` is the field
 * that names the REMEDY, and whether pressing the button again could help is a
 * question about the remedy rather than about how much was observed.
 * `incomplete` is the only status a repair can fix — the read succeeded and
 * some labels are missing, drifted, or failed to write. `refused` and
 * `no_credential` are not fixed by pressing the button again, and offering it
 * there would imply they might be; that stays true for a write-phase refusal,
 * which knows its counts and is still refused for exactly the reason another
 * attempt would be. `rate_limited` and `unreachable` clear on their own, which
 * is what Check answers; a repair issued into either just spends another
 * request on a refusal.
 *
 * ## After a repair, read `action` and never `stateBefore`
 *
 * `stateBefore` is what GitHub had before the call and is deliberately not
 * rewritten by a successful write, so a created label reads
 * `stateBefore: 'missing'` with `action: 'created'`. `repairOutcome` reports
 * the counts — created, updated, failed — rather than re-deriving anything
 * from `stateBefore`, which would report a label as still missing having just
 * made it.
 */

import type {
  LabelProvisioningReport,
  LabelState,
  ProvisionedLabelKind,
} from '../types/repositoryLabels';

// ---------------------------------------------------------------------------
// Was anything actually observed?
// ---------------------------------------------------------------------------

/**
 * A report whose labels WERE read, so its counts are numbers.
 *
 * The narrowing is the point: past `wasRead`, TypeScript stops accepting
 * `report.present` in a template string, so a count cannot be rendered from an
 * unread report even by mistake. That is a compile error rather than a review
 * comment, which is what the API asked for when it made these nullable.
 */
export type ReadLabelReport = LabelProvisioningReport & {
  declared: number;
  present: number;
  missing: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
};

/**
 * Whether GitHub's label list was actually obtained.
 *
 * **A null check, deliberately, and not a `status` check** — see the header:
 * a write-phase refusal carries a real count and would be blanked by one.
 *
 * All seven are checked rather than just `present`, though the API guarantees
 * they move together. It costs one expression, it makes the type predicate
 * something this file has verified rather than something it asserts on the
 * API's behalf, and a contract violation then degrades to "not read" — the
 * safe direction, since the failure mode being guarded against is rendering a
 * number nobody established.
 */
export function wasRead(
  report: LabelProvisioningReport,
): report is ReadLabelReport {
  return (
    report.declared !== null &&
    report.present !== null &&
    report.missing !== null &&
    report.created !== null &&
    report.updated !== null &&
    report.unchanged !== null &&
    report.failed !== null
  );
}

/**
 * "12 of 15 labels present", or **null when nobody could look**.
 *
 * Null is the whole point: see the header. The caller renders the status's
 * remedy and the API's `detail` instead, and never a zero.
 */
export function countSentence(report: LabelProvisioningReport): string | null {
  if (!wasRead(report)) return null;
  return `${report.present} of ${report.declared} labels present`;
}

// ---------------------------------------------------------------------------
// The three kinds, and what missing one of them costs
// ---------------------------------------------------------------------------

export interface KindPresentation {
  /** The heading over this kind's missing labels. */
  title: string;
  /** What is lost while these are absent, in the operator's terms. */
  consequence: string;
}

const KIND_PRESENTATION: Record<ProvisionedLabelKind, KindPresentation> = {
  input: {
    title: 'Input labels — the control surface',
    consequence:
      'These are how a human steers the factory, and factory:ready is the ' +
      'whole eligibility signal: an issue without it is skipped. GitHub’s ' +
      'label picker only offers labels that exist, so while these are ' +
      'missing no issue in this repository can be marked ready except by ' +
      'typing the name by hand, spelled exactly right.',
  },
  mirror: {
    title: 'Mirror labels — what Opifex writes back',
    consequence:
      'Opifex writes these to show what it is doing; it never reads them as ' +
      'truth. GitHub would create a missing one on first write anyway — with ' +
      'a random colour and no description, which is exactly what the warm / ' +
      'cool palette exists to prevent, since colour is what tells an input ' +
      'label apart from a mirror one at a glance.',
  },
  routing: {
    title: 'Routing labels — what the work needs',
    consequence:
      'These describe the work rather than steer the factory. Missing them ' +
      'costs nothing catastrophic: runs still happen, but only on the ' +
      'defaults, because a capability requirement or a model tier can no ' +
      'longer be asked for.',
  },
};

/** How to present one kind, including one this build has never heard of. */
export function kindPresentation(kind: string): KindPresentation {
  return (
    KIND_PRESENTATION[kind as ProvisionedLabelKind] ?? {
      title: `${kind} labels`,
      consequence:
        'This build does not recognise that label kind, so it will not ' +
        'guess at what depends on it. The names are listed as the API gave ' +
        'them.',
    }
  );
}

/** The declared kinds, in the order a report should present them. */
export const LABEL_KIND_ORDER: readonly ProvisionedLabelKind[] = [
  'input',
  'mirror',
  'routing',
];

export interface KindGroup {
  kind: string;
  presentation: KindPresentation;
  labels: LabelState[];
}

/**
 * Group labels by kind, in `LABEL_KIND_ORDER`, dropping empty groups.
 *
 * Kinds the API sends that this build does not know about are kept, after the
 * declared ones, rather than silently dropped — a label that exists and is not
 * rendered is worse than one rendered without an explanation.
 */
export function groupByKind(labels: readonly LabelState[]): KindGroup[] {
  const seen: string[] = [];
  for (const label of labels) {
    if (!seen.includes(label.kind)) seen.push(label.kind);
  }

  const ordered = [
    ...LABEL_KIND_ORDER.filter((kind) => seen.includes(kind)),
    ...seen.filter(
      (kind) => !LABEL_KIND_ORDER.includes(kind as ProvisionedLabelKind),
    ),
  ];

  return ordered.map((kind) => ({
    kind,
    presentation: kindPresentation(kind),
    labels: labels.filter((label) => label.kind === kind),
  }));
}

// ---------------------------------------------------------------------------
// Which labels a report is actually about
// ---------------------------------------------------------------------------

/**
 * The labels that were not on GitHub, **as observed** — `stateBefore`, not
 * `action`.
 *
 * Called only on an inspection. After a repair the caller reads
 * `outstandingLabels` instead, because `stateBefore` is not rewritten by a
 * successful write and this would name a label that now exists.
 */
export function missingLabels(report: LabelProvisioningReport): LabelState[] {
  return report.labels.filter((label) => label.stateBefore === 'missing');
}

/** The labels that existed and no longer matched the declaration. */
export function driftedLabels(report: LabelProvisioningReport): LabelState[] {
  return report.labels.filter((label) => label.stateBefore === 'drifted');
}

/**
 * What is STILL wrong after this report, whether or not it wrote anything.
 *
 * For an inspection (`attempted: false`) that is everything not `present`. For
 * a repair it is what the repair did not fix: a label whose write failed, one
 * that was missing and that the call did not act on, or — after a write-phase
 * refusal — everything the call never got to. A label with `action: 'created'`
 * or `'updated'` is NOT outstanding; reading `stateBefore` there would report
 * a label as missing having just created it, which is the exact trap the API's
 * field name warns about.
 */
export function outstandingLabels(
  report: LabelProvisioningReport,
): LabelState[] {
  return report.labels.filter((label) => {
    if (label.action === 'created' || label.action === 'updated') return false;
    return label.stateBefore !== 'present' || label.action === 'failed';
  });
}

/** The labels this call created or updated. Empty for an inspection. */
export function repairedLabels(report: LabelProvisioningReport): LabelState[] {
  return report.labels.filter(
    (label) => label.action === 'created' || label.action === 'updated',
  );
}

/** The labels this call tried to write and could not, one at a time. */
export function failedLabels(report: LabelProvisioningReport): LabelState[] {
  return report.labels.filter((label) => label.action === 'failed');
}

// ---------------------------------------------------------------------------
// Status — nine statuses, because there are nine remedies
// ---------------------------------------------------------------------------

export interface LabelStatusPresentation {
  severity: 'success' | 'info' | 'warning' | 'error';
  /** The heading. Names the situation, never "Error". */
  title: string;
  /** What to do about it, in this build's words. */
  remedy: string;
  /**
   * Whether pressing the repair action could change the outcome. See the
   * header: offering it where it cannot is a promise this screen would break.
   */
  repairable: boolean;
}

const STATUS_PRESENTATION: Record<string, LabelStatusPresentation> = {
  ok: {
    severity: 'success',
    title: 'Every declared label is on GitHub',
    remedy:
      'Nothing to do. This is an observation of that moment, not a stored ' +
      'setting — a label deleted on GitHub afterwards will not un-say it.',
    repairable: false,
  },
  incomplete: {
    severity: 'warning',
    title: 'Some declared labels are missing or out of date',
    remedy:
      'Create the missing ones below. Nothing is ever deleted: a label on ' +
      'the repository that is not part of the taxonomy is left exactly as it ' +
      'is, because deleting one strips it from every issue carrying it.',
    repairable: true,
  },
  no_credential: {
    severity: 'info',
    title: 'No GitHub credential is configured, so nothing was asked',
    remedy:
      'Set github.token in the Credentials section, then check again. ' +
      'Nothing is wrong with this repository — there was simply nothing to ' +
      'ask GitHub with.',
    repairable: false,
  },
  invalid_credential: {
    severity: 'error',
    title: 'GitHub rejected the credential',
    remedy:
      'The token is wrong, revoked or expired — a fine-grained token expires ' +
      'on a fixed date and then fails exactly like this. Replace it in the ' +
      'Credentials section. Creating labels now would fail the same way.',
    repairable: false,
  },
  refused: {
    severity: 'warning',
    title: 'The credential authenticated and was not permitted',
    remedy:
      'The token is valid and may not write this repository’s labels. Give ' +
      'it Issues: read and write for this repository on GitHub — ADR-0001 ' +
      'chose a fine-grained token, which grants one repository and one ' +
      'permission at a time, so reading a repository never implied being ' +
      'able to label it. Pressing repair again cannot fix this; widen the ' +
      'token’s permissions and check again.',
    repairable: false,
  },
  not_found: {
    severity: 'error',
    title: 'GitHub answered 404 for this repository',
    remedy:
      'It has been deleted, renamed, or is no longer visible to this token. ' +
      'Nothing can be created on a repository that cannot be found — check ' +
      'the name on GitHub, or the token’s repository access.',
    repairable: false,
  },
  rate_limited: {
    severity: 'warning',
    title: 'GitHub’s rate limit is exhausted',
    remedy:
      'The credential is fine and the hourly budget is spent; the reset time ' +
      'is below. ADR-0001 notes Opifex shares the operator’s own budget, so ' +
      'this can equally have been caused by something other than Opifex. ' +
      'Check again after the reset — a repair issued now would just spend ' +
      'another refused request.',
    repairable: false,
  },
  unreachable: {
    severity: 'warning',
    title: 'Nothing answered',
    remedy:
      'The request never got a usable reply, so the credential was never ' +
      'judged and this says nothing at all about the token. Check the ' +
      'network, the proxy and github.apiBaseUrl, then check again.',
    repairable: false,
  },
  failed: {
    severity: 'error',
    title: 'GitHub answered something unexpected',
    remedy:
      'Neither a credential verdict nor a network failure. GitHub’s own ' +
      'answer is quoted below. Checking again shortly is usually the right ' +
      'move.',
    repairable: false,
  },
};

/**
 * How to render one status, including one this build has never heard of.
 *
 * The fallback prints the raw word rather than folding an unknown status into
 * `failed`, and withholds the repair action: the API's `detail` is written for
 * a human and is always shown, so a status this build cannot interpret still
 * arrives with its explanation intact — but a write whose semantics this build
 * cannot predict is not offered.
 */
export function labelStatusPresentation(
  status: string,
): LabelStatusPresentation {
  return (
    STATUS_PRESENTATION[status] ?? {
      severity: 'warning',
      title: `The API reported “${status}”`,
      remedy:
        'This build does not recognise that status, so it will not guess at ' +
        'a remedy or offer to write anything. The API’s own explanation is ' +
        'below.',
      repairable: false,
    }
  );
}

/**
 * Whether to offer the repair action for this report at all.
 *
 * Decided from `status` on purpose. `status` is the field that names the
 * remedy, and "would pressing this again help?" is a question about the
 * remedy — not about how much this particular call managed to observe. So a
 * write-phase refusal, which knows its counts perfectly well, still does not
 * get the button: it was refused for precisely the reason a second attempt
 * would be, and the fix is the token's permissions.
 */
export function canRepair(report: LabelProvisioningReport): boolean {
  return labelStatusPresentation(report.status).repairable;
}

/**
 * The headline over an observation.
 *
 * Split out of the raw status so the count leads when there IS one: "12 of 15
 * labels present" is the sentence an operator scans for, and it may only be
 * said when the labels were actually read.
 */
export function observationPresentation(
  report: LabelProvisioningReport,
): LabelStatusPresentation {
  const base = labelStatusPresentation(report.status);
  const count = countSentence(report);
  if (count === null) return base;
  return { ...base, title: count };
}

// ---------------------------------------------------------------------------
// What a repair actually did
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  severity: 'success' | 'warning' | 'error';
  title: string;
  body: string;
}

/**
 * What the repair did, in its own counts — created, updated, failed.
 *
 * Reported from `action` and the report's counters, never from `stateBefore`;
 * see the header. Partial success is an ordinary outcome and is reported as
 * one: the labels that were created stay created, and saying "the repair
 * failed" over eleven successful creations would be false in the direction
 * that costs the operator another attempt.
 *
 * Three shapes of partial, and they are not the same:
 *
 *  - **per-label failures** — GitHub refused these particular labels and the
 *    run continued (`status: 'incomplete'`, `failed > 0`);
 *  - **a write cut short** — GitHub refused the repository, so the loop
 *    stopped where it was (a failure `status` WITH real counts, `failed: 0`,
 *    and possibly some already created);
 *  - **nothing attempted at all** — the read itself failed, so no count exists
 *    and none is invented.
 */
export function repairOutcome(report: LabelProvisioningReport): RepairOutcome {
  if (!wasRead(report)) {
    const presentation = labelStatusPresentation(report.status);
    return {
      severity: presentation.severity === 'success' ? 'warning' : 'error',
      title: 'Nothing was written',
      body:
        `${presentation.title}. ${presentation.remedy} No label on this ` +
        'repository was created, changed or removed.',
    };
  }

  const wrote = report.created + report.updated;

  // The read succeeded and GitHub then stopped the write — a refusal, a rate
  // limit, a network that went away mid-loop. Distinguished from a per-label
  // failure because the remedy is about the repository rather than about the
  // labels that did not take, and from an unread report because the counts
  // here are real and worth saying.
  if (report.status !== 'ok' && report.status !== 'incomplete') {
    const presentation = labelStatusPresentation(report.status);
    return {
      severity: presentation.severity === 'success' ? 'warning' : 'error',
      title:
        wrote === 0
          ? presentation.title
          : `${wrote} written before GitHub stopped the rest`,
      body:
        `${presentation.remedy} ${report.present} of ${report.declared} ` +
        `declared labels are on ${report.repository} as of now` +
        (wrote === 0
          ? ', unchanged by this attempt.'
          : ', counting what this attempt managed to create.'),
    };
  }

  if (report.failed > 0) {
    return {
      severity: 'warning',
      title:
        wrote === 0
          ? `No label could be written — ${report.failed} failed`
          : `${wrote} written, ${report.failed} failed`,
      body:
        wrote === 0
          ? 'Every write was refused. Each label’s own reason is below.'
          : 'The labels that were written stay written — they are what was ' +
            'asked for. The ones that failed are listed below with GitHub’s ' +
            'own reason for each, and can be tried again.',
    };
  }

  if (wrote === 0) {
    return {
      severity: 'success',
      title: 'Nothing needed creating',
      body:
        `All ${report.declared} declared labels were already present and ` +
        'already matched. Running this again is a no-op, by design.',
    };
  }

  return {
    severity: 'success',
    title: repairHeadline(report.created, report.updated),
    body:
      `${report.present} of ${report.declared} declared labels are now on ` +
      `${report.repository}. Nothing was deleted — a label outside the ` +
      'taxonomy was left exactly as it was.',
  };
}

function repairHeadline(created: number, updated: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// What a registration's provisioning did (#415, on `POST /api/repositories`)
// ---------------------------------------------------------------------------

export interface RegistrationLabelNote {
  severity: 'success' | 'info' | 'warning' | 'error';
  title: string;
  body: string;
}

/** What to do next, given whether pressing repair could help. */
function nextStep(repairable: boolean): string {
  return repairable
    ? 'The repository is registered and observed either way — use Create ' +
        'missing labels on its card.'
    : 'The repository is registered and observed either way. Deal with the ' +
        'reason above, then check its labels again from its card.';
}

/**
 * What to say about the labels of a repository that was just registered — or
 * null when there is nothing worth saying.
 *
 * Null for a clean provisioning: the registration alert above already says the
 * repository is registered, and "and its labels were created" is the expected
 * case rather than news.
 *
 * **Both facts, always, in that order.** A refused provisioning is not a
 * failed registration: the repository IS registered and is observed, and only
 * the labels are missing. ADR-0001's fine-grained token grants one repository
 * and one permission at a time, so "could read it" genuinely does not imply
 * "can create labels in it" — this is an expected outcome of a correct
 * configuration, and the tone says so rather than reading like a fault.
 */
export function registrationLabelNote(
  fullName: string,
  report: LabelProvisioningReport | null | undefined,
): RegistrationLabelNote | null {
  // The FIELD IS ABSENT rather than null: an API from before #415, which never
  // provisioned anything and so has nothing to report. Silent on purpose —
  // there is no outcome to describe and no action to offer, and a warning on
  // every registration that nobody can act on is one nobody reads. Check
  // labels on the card is where that deployment finds out what is there.
  if (report === undefined) return null;

  if (report === null) {
    return {
      severity: 'warning',
      title: `${fullName} is registered; its labels were not reported on`,
      body:
        'Registration succeeded and label provisioning gave no account of ' +
        'itself, which should not happen. Use Check labels on the ' +
        'repository’s card to find out what is actually there.',
    };
  }

  if (report.ok) return null;

  const presentation = labelStatusPresentation(report.status);
  const severity =
    presentation.severity === 'success' ? 'warning' : presentation.severity;

  // The labels WERE read, so how many are absent is known — including after a
  // write GitHub cut short, which knows its counts perfectly well. Saying the
  // number is better than "could not be created", which is vaguer and, for a
  // partial write, not even true of every label.
  if (wasRead(report)) {
    const absent = report.missing + report.failed;
    return {
      severity,
      title:
        `${fullName} is registered; ${absent} of ${report.declared} labels ` +
        'are not on it',
      body:
        `${presentation.remedy} ${report.detail} ` +
        nextStep(presentation.repairable),
    };
  }

  return {
    severity,
    title: `${fullName} is registered; its labels could not be created`,
    body:
      `${presentation.title}. ${presentation.remedy} ${report.detail} The ` +
      'registration itself stands — the repository is registered and ' +
      'observed. Until the labels exist, GitHub’s picker cannot offer ' +
      'factory:ready, which is what marks an issue eligible for dispatch.',
  };
}

/**
 * One line for a per-repository batch report row, under "Registered."
 *
 * Short on purpose: this sits in a list of up to twenty-five rows, and the
 * full explanation belongs in the note above the list rather than repeated
 * once per repository.
 */
export function registrationLabelLine(
  report: LabelProvisioningReport | null | undefined,
): string | null {
  // Absent field: an API from before #415. Nothing to say — see
  // `registrationLabelNote`.
  if (report === undefined) return null;
  if (report === null) return 'Label provisioning gave no account of itself.';
  if (!wasRead(report)) {
    return `Labels not created: ${labelStatusPresentation(report.status).title.toLowerCase()}.`;
  }
  if (report.ok) {
    return report.created > 0
      ? `${report.created} of ${report.declared} labels created.`
      : `All ${report.declared} labels were already present.`;
  }
  return `${report.present} of ${report.declared} labels present.`;
}
