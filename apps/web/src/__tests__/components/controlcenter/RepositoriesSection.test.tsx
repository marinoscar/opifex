/**
 * The Control Center's Repositories section, now a signpost (#406, epic #403).
 *
 * The section did not disappear when the ladder moved to `/projects`, and the
 * cases here are the two failure modes of "move a feature out of a settings
 * screen":
 *
 *  - **deleting the section silently.** An operator who came looking for the
 *    enablement ladder — because that is where it was, and because the
 *    Readiness chain still counts registered repositories and links here —
 *    would find nothing and conclude the feature was removed.
 *  - **leaving a second editor behind.** Two screens writing
 *    `PATCH /repositories/:id` are two places for the same switch to disagree.
 *    So this one must read nothing and write nothing.
 *
 * The second is asserted the only way it can be asserted honestly: by watching
 * the network. A section that renders no switches but still fires
 * `GET /repositories` would still be reading rows it has no business reading,
 * for an account that may hold `system_settings:read` and not `projects:read`.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { RepositoriesSection } from '../../../components/controlcenter/RepositoriesSection';
import { LADDER_RUNGS } from '../../../config/repositoryLadder';

const API_BASE = '*/api';

describe('RepositoriesSection', () => {
  it('names where the controls went, and offers a way there', () => {
    render(<RepositoriesSection canWrite />);

    expect(screen.getByText('Managed on Projects')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /go to projects/i }),
    ).toHaveAttribute('href', '/projects');
  });

  it('reads no repository at all', async () => {
    // The section is gated on `system_settings:read` and the list is gated on
    // `projects:read`. An account may hold the first and not the second, and
    // a request certain to 403 for a section that shows nothing is a request
    // worth not making.
    const reads: string[] = [];
    server.use(
      http.get(`${API_BASE}/repositories`, ({ request }) => {
        reads.push(request.url);
        return HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 25 },
        });
      }),
    );

    render(<RepositoriesSection canWrite />);

    // Given a chance to fire — the section is fully rendered by now.
    await waitFor(() =>
      expect(screen.getByText('Managed on Projects')).toBeInTheDocument(),
    );
    expect(reads).toEqual([]);
  });

  it('offers no control that writes', () => {
    render(<RepositoriesSection canWrite />);

    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: /^add repository$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^save$/i }),
    ).not.toBeInTheDocument();
  });

  it('still states the ladder in its own order', () => {
    // The progression is the design (VISION §12), and the settings screen
    // accounting for repositories without owning them still has to say what
    // enabling one means.
    render(<RepositoriesSection canWrite />);

    const rendered = LADDER_RUNGS.map((rung) => rung.title);
    const listed = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');

    expect(listed).toHaveLength(rendered.length);
    rendered.forEach((title, index) => {
      expect(listed[index]).toContain(title);
    });
  });

  it('says which permission a reader is missing', () => {
    render(<RepositoriesSection canWrite={false} />);

    expect(screen.getByText('projects:write')).toBeInTheDocument();
  });
});
