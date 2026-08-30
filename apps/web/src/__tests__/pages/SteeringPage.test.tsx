/**
 * The steering chat, end to end over MSW (#426, epic #419).
 *
 * The two endpoints are served by MSW rather than stubbed on the module, so
 * these tests see the requests a browser would really issue and can assert
 * what is on the wire — which matters here more than usual, because
 * `observedInputLabels` is a field the SERVER compares against a fresh read
 * and no amount of correct rendering makes up for reshaping it.
 *
 * Every fixture is built by `mocks/steering.ts`, which is type-checked against
 * the wire types (#417).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render, mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  APPLY_ACCEPTED,
  PROPOSE_OK,
  applyResponse,
  applyResultFixture,
  needsInterpretationFixture,
  proposalFixture,
  proposalResponse,
  staleProposalResponse,
} from '../mocks/steering';
import {
  PROJECT_ID,
  projectFixture,
  repositoryFixture,
} from '../mocks/repositories';
import SteeringPage from '../../pages/SteeringPage';
import type {
  ApplySteeringInput,
  SteeringApplyResult,
  SteeringProposal,
} from '../../types/steering';

/** The seeded `admin` role really holds `workorders:write` (`prisma/seed.ts`). */
const steerer = mockAdminUser;

const INSTRUCTION = 'only work on #1, #2 and #3';

/** Every mutating request the page makes, so an unexpected write is visible. */
function recordWrites(): string[] {
  const written: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'GET')
      written.push(`${request.method} ${request.url}`);
  });
  return written;
}

function serveProposal(proposal: SteeringProposal) {
  server.use(
    http.post('*/api/steering/proposals', () => proposalResponse(proposal)),
  );
}

/** Serve apply, capturing the request body each time it is called. */
function serveApply(
  answer: (body: ApplySteeringInput) => Response,
): ApplySteeringInput[] {
  const bodies: ApplySteeringInput[] = [];
  server.use(
    http.post('*/api/steering/proposals/apply', async ({ request }) => {
      const body = (await request.json()) as ApplySteeringInput;
      bodies.push(body);
      return answer(body);
    }),
  );
  return bodies;
}

const applyOk = (result: SteeringApplyResult) => () => applyResponse(result);

/** Capture every propose body, so what the scope picker really sent is read
 *  off the wire rather than off a spy. */
function captureProposals(proposal: SteeringProposal) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post('*/api/steering/proposals', async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return proposalResponse(proposal);
    }),
  );
  return bodies;
}

/**
 * The registered set and the projects the scope picker reads.
 *
 * Two repositories, one filed and one not, because that is the shape every
 * interesting case here needs: a project to expand, and the unassigned bucket
 * that a project-only picker would leave unreachable.
 */
function serveScopes() {
  server.use(
    http.get('*/api/repositories', () =>
      HttpResponse.json({
        data: {
          items: [
            repositoryFixture({
              id: 'repo-widgets',
              owner: 'opifex',
              name: 'opifex',
              fullName: 'opifex/opifex',
              projectId: PROJECT_ID,
              observeEnabled: true,
            }),
            repositoryFixture({
              id: 'repo-legacy',
              owner: 'acme',
              name: 'legacy',
              fullName: 'acme/legacy',
              projectId: null,
              observeEnabled: true,
            }),
          ],
          total: 2,
          page: 1,
          pageSize: 100,
        },
      }),
    ),
    http.get('*/api/projects', () =>
      HttpResponse.json({
        data: {
          items: [projectFixture({ id: PROJECT_ID, name: 'Billing Platform' })],
          total: 1,
          page: 1,
          pageSize: 100,
          totalPages: 1,
        },
      }),
    ),
  );
}

/** Pick a scope by its visible label in the select. */
async function chooseScope(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await user.click(await screen.findByRole('combobox', { name: /Scope/ }));
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByText(label));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

function renderPage() {
  return render(<SteeringPage />, { wrapperOptions: { user: steerer } });
}

async function propose(
  user: ReturnType<typeof userEvent.setup>,
  instruction = INSTRUCTION,
) {
  await user.type(screen.getByLabelText('Steering instruction'), instruction);
  await user.click(
    screen.getByRole('button', {
      name: 'Propose a label diff for this instruction',
    }),
  );
}

const applyButton = () =>
  screen.getByRole('button', { name: 'Apply the selected label changes' });

/**
 * The size-and-variant classes that decide how loud a chip is.
 *
 * Colour is excluded on purpose — the two directions differ by colour and by
 * the verb, and by nothing else. Everything that makes one chip more prominent
 * than another is in here, which is what makes the comparison mean something.
 */
function emphasisClasses(element: HTMLElement): string[] {
  return [...element.classList]
    .filter((name) => /^MuiChip-(size[A-Z]\w*|filled|outlined)$/.test(name))
    .sort();
}

describe('SteeringPage', () => {
  beforeEach(() => {
    server.events.removeAllListeners();
  });

  it('turns an instruction naming issue numbers into a diff, and writes nothing', async () => {
    const user = userEvent.setup();
    const writes = recordWrites();
    serveProposal(proposalFixture());
    serveApply(applyOk(applyResultFixture()));
    renderPage();

    await propose(user);

    // The diff exists on screen…
    await screen.findByTestId('proposal-review');
    expect(screen.getByText(/5 issues affected/)).toBeInTheDocument();
    expect(
      screen.getByText('opifex/opifex#1 — Wire the metrics summary endpoint'),
    ).toBeInTheDocument();

    // …and NOTHING has been applied. Not for a confident deterministic parse,
    // not for anything: the confirmation is the whole guarantee that this chat
    // is not a second controller.
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatch(/\/api\/steering\/proposals$/);
    expect(writes.some((write) => write.endsWith('/apply'))).toBe(false);
  });

  it('applies only when the confirmation is pressed, and reports per issue', async () => {
    const user = userEvent.setup();
    const writes = recordWrites();
    serveProposal(proposalFixture());
    const bodies = serveApply(
      applyOk(
        applyResultFixture({
          applied: [
            {
              ref: 'opifex/opifex#1',
              add: ['factory:ready'],
              remove: [],
              writes: [
                {
                  label: 'factory:ready',
                  operation: 'add',
                  performed: true,
                  noop: false,
                },
              ],
            },
            {
              ref: 'opifex/opifex#17',
              add: [],
              remove: ['factory:ready'],
              writes: [
                {
                  label: 'factory:ready',
                  operation: 'remove',
                  performed: true,
                  noop: false,
                },
              ],
            },
          ],
        }),
      ),
    );
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    const report = await screen.findByTestId('apply-report');
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(writes.filter((write) => write.endsWith('/apply'))).toHaveLength(1);
    // Every issue is named individually: a headline is only ever a summary.
    expect(within(report).getByText('opifex/opifex#1')).toBeInTheDocument();
    expect(within(report).getByText('opifex/opifex#17')).toBeInTheDocument();
    expect(
      within(report).getByText(/factory:ready removed — written/),
    ).toBeInTheDocument();
  });

  it('draws a removal exactly as loudly as an addition', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    const additions = screen.getAllByTestId('label-add');
    const removals = screen.getAllByTestId('label-remove');

    // The fixture's "only" clause un-readies two issues nobody named. Every
    // one of them is on screen as its own chip.
    expect(additions).toHaveLength(3);
    expect(removals).toHaveLength(2);
    expect(screen.getAllByText('Removes factory:ready')).toHaveLength(2);

    for (const removal of removals) {
      // Not in a title attribute, not in a collapsed section, not behind a
      // "show more": rendered, visible text.
      expect(removal).toBeVisible();
      expect(removal).toHaveTextContent('Removes factory:ready');
      // Same size, same variant, same weight as an addition. The only
      // difference between the two is the colour and the verb — anything that
      // made a removal quieter would show up right here.
      expect(emphasisClasses(removal)).toEqual(emphasisClasses(additions[0]));
    }
  });

  it('states the blast radius above the operations, not after them', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    const headline = screen.getByText(/5 issues affected/);
    const firstOperation = screen.getByText(
      'opifex/opifex#1 — Wire the metrics summary endpoint',
    );

    // A list is something to check a claim against, so the claim comes first.
    expect(
      headline.compareDocumentPosition(firstOperation) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/un-ready 2 issues/)).toBeInTheDocument();
    expect(
      screen.getByText(/2 issues the instruction did not name/),
    ).toBeInTheDocument();
  });

  it('separates the issues that were named from the collateral', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    expect(screen.getByText('Issues you named (3)')).toBeInTheDocument();
    expect(
      screen.getByText('Collateral — not named by your instruction (2)'),
    ).toBeInTheDocument();
    // The collateral caption specifically — the blast-radius body says its own
    // version of this above, and both are meant to be there.
    expect(
      screen.getByText(/Nobody typed them, and un-readying one discards/),
    ).toBeInTheDocument();
  });

  it('echoes observedInputLabels back verbatim so drift detection still works', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    const bodies = serveApply(applyOk(applyResultFixture()));
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = bodies[0].operations;

    // The baseline the server re-reads each issue against. #1 carries a label
    // steering may not even write, and it has to survive the round trip: a
    // client that narrowed this to the steerable two, sorted it, or dropped it
    // because "the server knows" would turn drift detection off while leaving
    // every other assertion in this file green.
    expect(sent.find((operation) => operation.number === 1)).toEqual({
      owner: 'opifex',
      name: 'opifex',
      number: 1,
      add: ['factory:ready'],
      remove: [],
      observedInputLabels: ['factory:quarantined'],
    });
    expect(
      sent.find((operation) => operation.number === 17)?.observedInputLabels,
    ).toEqual(['factory:ready']);
    expect(
      sent.find((operation) => operation.number === 2)?.observedInputLabels,
    ).toEqual([]);
  });

  it('applies only what is still ticked', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    const bodies = serveApply(applyOk(applyResultFixture()));
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    await user.click(
      screen.getByRole('checkbox', { name: 'Include opifex/opifex#17' }),
    );

    // The headline still describes the INSTRUCTION, not the current ticks —
    // otherwise un-ticking everything would read as "nothing will change" over
    // a proposal that removes two labels.
    expect(screen.getByText(/5 issues affected/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Applying 4 of 5 operations: 3 labels added, 1 removed.',
      ),
    ).toBeInTheDocument();

    await user.click(applyButton());
    await waitFor(() => expect(bodies).toHaveLength(1));

    expect(bodies[0].operations.map((operation) => operation.number)).toEqual([
      1, 2, 3, 18,
    ]);
  });

  it('reads needs-interpretation as the ordinary answer for prose', async () => {
    const user = userEvent.setup();
    serveProposal(needsInterpretationFixture());
    renderPage();

    await propose(user, 'just the auth epic please');
    await screen.findByTestId('proposal-review');

    const notice = screen.getByText(
      'This needs interpretation, so nothing was proposed for it',
    );
    const alert = notice.closest('.MuiAlert-root');

    // Information, not an error. The model path is refused on purpose, so
    // colouring this red would teach an operator to ignore red.
    expect(alert).toHaveClass('MuiAlert-colorInfo');
    expect(
      screen.getByText(/No model was asked\..*no spend ceiling/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No chat model is configured on this deployment/),
    ).toBeInTheDocument();
    // And what to do instead, which works on this deployment today.
    expect(
      screen.getByText(/Name the issues explicitly and no model is needed/),
    ).toBeInTheDocument();
    // Nothing to confirm: there are no operations.
    expect(applyButton()).toBeDisabled();
  });

  it('reports unresolved references as outcomes rather than as a failed send', async () => {
    const user = userEvent.setup();
    serveProposal(
      proposalFixture({
        unresolved: [
          {
            reference: 'opifex/opifex#404',
            reason: 'issue-not-found',
            detail:
              'opifex/opifex#404 could not be read. It may not exist, may have been transferred, or may be private to this token.',
          },
          {
            reference: '#7',
            reason: 'ambiguous-repository',
            detail:
              '#7 is ambiguous: more than one repository is registered. Name it as owner/name#7.',
          },
        ],
      }),
    );
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    expect(
      screen.getByText('2 references produced no operation'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('opifex/opifex#404 — issue-not-found'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Name it as owner\/name#7/)).toBeInTheDocument();
    // The rest of the proposal is still applicable: an unresolved reference is
    // an observation, not a reason to refuse the other five issues.
    expect(applyButton()).toBeEnabled();
  });

  it('says the operations were recorded and not performed when writes are disabled', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    serveApply(
      applyOk(
        applyResultFixture({
          writesEnabled: false,
          labelWritten: false,
          applied: [
            {
              ref: 'opifex/opifex#1',
              add: ['factory:ready'],
              remove: [],
              writes: [
                {
                  label: 'factory:ready',
                  operation: 'add',
                  performed: false,
                  noop: false,
                },
              ],
            },
          ],
          summary: {
            operationsRequested: 1,
            operationsApplied: 1,
            operationsSkipped: 0,
            labelWrites: 1,
            labelWritesPerformed: 0,
          },
        }),
      ),
    );
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    const report = await screen.findByTestId('apply-report');

    // A 202 with nothing written is not a success and not a failure.
    expect(report).toHaveClass('MuiAlert-colorWarning');
    expect(
      within(report).getByText(/Nothing was written for any of the/),
    ).toBeInTheDocument();
    // Said in the headline AND on the issue's own line, in the queue screen's
    // words for the same kill switch.
    expect(
      within(report).getAllByText(/writes are disabled on this deployment/)
        .length,
    ).toBeGreaterThan(1);
    expect(
      within(report).getByText(/github\.writesEnabled is off/),
    ).toBeInTheDocument();
  });

  it('reads a 409 as a stale proposal and offers the instruction again', async () => {
    const user = userEvent.setup();
    const proposals: string[] = [];
    server.use(
      http.post('*/api/steering/proposals', async ({ request }) => {
        const body = (await request.json()) as { instruction: string };
        proposals.push(body.instruction);
        return proposalResponse(proposalFixture());
      }),
    );
    serveApply(() => staleProposalResponse());
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    const alert = await screen.findByText(
      'This proposal is stale — nothing was written',
    );
    const banner = alert.closest('.MuiAlert-root');

    // Not an error: a proposal is a picture of a backlog at a moment, and the
    // answer to a stale one is to ask again.
    expect(banner).toHaveClass('MuiAlert-colorWarning');
    expect(
      screen.getByText(/Propose the same instruction again/),
    ).toBeInTheDocument();

    // The spent proposal is retired rather than left offering a button the
    // API will refuse every time.
    expect(
      screen.queryByRole('button', {
        name: 'Apply the selected label changes',
      }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Propose this instruction again' }),
    );
    await waitFor(() => expect(proposals).toEqual([INSTRUCTION, INSTRUCTION]));
  });

  it('keeps a drifted issue visible with what moved under it', async () => {
    const user = userEvent.setup();
    serveProposal(proposalFixture());
    serveApply(
      applyOk(
        applyResultFixture({
          applied: [
            {
              ref: 'opifex/opifex#1',
              add: ['factory:ready'],
              remove: [],
              writes: [
                {
                  label: 'factory:ready',
                  operation: 'add',
                  performed: true,
                  noop: false,
                },
              ],
            },
          ],
          skipped: [
            {
              ref: 'opifex/opifex#17',
              reason: 'drift',
              detail:
                'The factory labels on opifex/opifex#17 changed after the proposal was made, so this operation was not applied. Ask for a new proposal to see the current picture.',
              drift: [
                { label: 'factory:ready', wasPresent: true, isPresent: false },
              ],
            },
          ],
        }),
      ),
    );
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    const report = await screen.findByTestId('apply-report');

    // A fraction of what was requested: "1 applied" alone would read as the
    // whole answer.
    expect(
      within(report).getByText('1 of 2 operations applied — 1 skipped'),
    ).toBeInTheDocument();
    expect(within(report).getByText('opifex/opifex#17')).toBeInTheDocument();
    expect(
      within(report).getByText(/changed after the proposal was made/),
    ).toBeInTheDocument();
    expect(
      within(report).getByText(
        'factory:ready was on the issue when this was proposed and is not now.',
      ),
    ).toBeInTheDocument();
    // The one that landed stays landed.
    expect(within(report).getByText(/stay landed/)).toBeInTheDocument();
  });

  it('discards a proposal without writing anything', async () => {
    const user = userEvent.setup();
    const writes = recordWrites();
    serveProposal(proposalFixture());
    serveApply(applyOk(applyResultFixture()));
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    await user.click(
      screen.getByRole('button', {
        name: 'Discard this proposal without writing anything',
      }),
    );

    expect(
      await screen.findByText(/Discarded\. No label was written/),
    ).toBeInTheDocument();
    expect(writes.some((write) => write.endsWith('/apply'))).toBe(false);
  });

  it('uses the statuses the two endpoints really answer with', async () => {
    const user = userEvent.setup();
    const statuses: number[] = [];
    server.events.on('response:mocked', ({ response }) => {
      statuses.push(response.status);
    });
    serveProposal(proposalFixture());
    serveApply(applyOk(applyResultFixture()));
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());
    await screen.findByTestId('apply-report');

    // 200 for propose — nothing has been accepted, because nothing has been
    // asked for. 202 for apply — the labels are a request a later tick acts on.
    expect(statuses).toContain(PROPOSE_OK);
    expect(statuses).toContain(APPLY_ACCEPTED);
  });

  /**
   * The scope on the WIRE, which is the only place the exclusivity matters:
   * the API answers 400 to two of `repository`, `project` and
   * `allRepositories`, and this asserts the browser cannot produce that body
   * however the picker is driven.
   */
  it('sends exactly one scope field, chosen from what exists', async () => {
    const user = userEvent.setup();
    serveScopes();
    const bodies = captureProposals(proposalFixture());
    renderPage();

    await chooseScope(user, 'Project: Billing Platform');
    await propose(user);
    await screen.findByTestId('proposal-review');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      instruction: INSTRUCTION,
      project: PROJECT_ID,
    });
    // No `repository`, no `allRepositories`, and no `project: undefined`
    // either: an undefined key still serialises out of the body, but a reader
    // of this assertion should be able to see the whole request.
    expect(Object.keys(bodies[0]).sort()).toEqual(['instruction', 'project']);
  });

  it('reaches a repository in no project, which a project-only picker could not', async () => {
    const user = userEvent.setup();
    serveScopes();
    const bodies = captureProposals(proposalFixture());
    renderPage();

    await chooseScope(user, 'No project (1)');
    await propose(user);
    await screen.findByTestId('proposal-review');

    expect(bodies[0]).toEqual({ instruction: INSTRUCTION, project: 'none' });
  });

  it('makes the deployment-wide sweep something typed, not the default', async () => {
    const user = userEvent.setup();
    serveScopes();
    const bodies = captureProposals(proposalFixture());
    renderPage();

    // Untouched: no scope field at all. ADR-0020 turned the absent field from
    // "sweep everything" into "ambiguous-scope", so this is the narrow answer.
    await propose(user);
    await screen.findByTestId('proposal-review');
    expect(bodies[0]).toEqual({ instruction: INSTRUCTION });

    await chooseScope(user, 'Every observed repository');
    await propose(user, 'hold #14');
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      instruction: 'hold #14',
      allRepositories: true,
    });
  });

  /**
   * `ambiguous-scope` and `empty-scope` are ADR-0020's two new reasons and get
   * the SAME treatment as the five before them: an outcome in the unresolved
   * list, never a failed send, with the API's own sentence rendered verbatim.
   */
  it('renders the two new unresolved reasons like every other one', async () => {
    const user = userEvent.setup();
    serveScopes();
    serveProposal(
      proposalFixture({
        unresolved: [
          {
            reference: INSTRUCTION,
            reason: 'ambiguous-scope',
            detail:
              '2 repositories are registered, so "everything else" could mean an issue in any of them.',
          },
          {
            reference: INSTRUCTION,
            reason: 'empty-scope',
            detail:
              'Billing Platform contains no observed repository, so there is nothing for "everything else" to reach.',
          },
        ],
      }),
    );
    renderPage();

    await propose(user);
    await screen.findByTestId('proposal-review');

    expect(
      screen.getByText('2 references produced no operation'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${INSTRUCTION} — ambiguous-scope`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`${INSTRUCTION} — empty-scope`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/could mean an issue in any of them/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contains no observed repository/),
    ).toBeInTheDocument();
    // Still applicable. An unresolved reference is an observation, not a
    // reason to refuse the operations that DID resolve.
    expect(applyButton()).toBeEnabled();
  });

  /**
   * "Propose again" has to ask the SAME question. Re-proposing a stale
   * instruction unscoped would put the mis-scoping this issue removed from the
   * input back through the retry button, where nobody would be looking for it.
   */
  it('keeps the scope when a stale proposal is proposed again', async () => {
    const user = userEvent.setup();
    serveScopes();
    const bodies = captureProposals(proposalFixture());
    serveApply(() => staleProposalResponse());
    renderPage();

    await chooseScope(user, 'acme/legacy');
    await propose(user);
    await screen.findByTestId('proposal-review');
    await user.click(applyButton());

    await user.click(
      await screen.findByRole('button', {
        name: 'Propose this instruction again',
      }),
    );

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      instruction: INSTRUCTION,
      repository: 'acme/legacy',
    });
  });

  it('reports a refused propose without pretending anything was written', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/steering/proposals', () =>
        HttpResponse.json(
          {
            statusCode: 404,
            message: 'opifex/other is not registered with Opifex.',
          },
          { status: 404 },
        ),
      ),
    );
    renderPage();

    await propose(user);

    expect(
      await screen.findByText('That scope is not something Opifex knows about'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/opifex\/other is not registered with Opifex\./),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-review')).toBeNull();
  });
});
