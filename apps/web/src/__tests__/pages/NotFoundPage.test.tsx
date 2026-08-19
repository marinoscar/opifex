import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render, mockAdminUser } from '../utils/test-utils';
import NotFoundPage from '../../pages/NotFoundPage';
import { DESTINATIONS } from '../../config/destinations';

/**
 * Issue #78, epic #19.
 *
 * The route this page replaces was `<Navigate to="/" replace />`, which turned
 * every wrong address into the dashboard. The page's whole job is to undo that
 * silence: say the address was wrong, say WHICH address, and offer a way on.
 * Each of those three is asserted below, because a 404 that gets any of them
 * wrong is indistinguishable from the redirect it replaced.
 */
describe('NotFoundPage', () => {
  it('says plainly that nothing is routed here', () => {
    render(<NotFoundPage />, { wrapperOptions: { route: '/nope' } });

    expect(screen.getByRole('heading', { level: 1, name: /page not found/i })).toBeInTheDocument();
  });

  it('echoes the attempted path verbatim, in the mono token', () => {
    // The entire diagnostic value of a 404: it is what turns "the app is
    // broken" into "I typed /setttings". The mono class is not decoration —
    // it is what makes a mistyped character visible.
    render(<NotFoundPage />, { wrapperOptions: { route: '/admin/setttings' } });

    const path = screen.getByText('/admin/setttings');
    expect(path).toBeInTheDocument();
    expect(path).toHaveClass('opifex-mono');
  });

  it('offers a way back to the cockpit', () => {
    render(<NotFoundPage />, { wrapperOptions: { route: '/nope' } });

    expect(screen.getByRole('link', { name: /back to the cockpit/i })).toHaveAttribute(
      'href',
      '/',
    );
  });

  describe('The destination list', () => {
    it('lists only what THIS user can reach', () => {
      // A 404 suggesting /admin/users to a Viewer produces a second dead end
      // from the first one.
      render(<NotFoundPage />, { wrapperOptions: { route: '/nope' } });

      const list = screen.getByRole('list', { name: /where you can go/i });
      expect(within(list).getByRole('link', { name: /user settings/i })).toBeInTheDocument();
      expect(within(list).queryByRole('link', { name: /user management/i })).not.toBeInTheDocument();
      expect(within(list).queryByRole('link', { name: /system settings/i })).not.toBeInTheDocument();
    });

    it('lists the admin destinations for a user holding their permissions', () => {
      render(<NotFoundPage />, {
        wrapperOptions: { route: '/nope', user: mockAdminUser },
      });

      const list = screen.getByRole('list', { name: /where you can go/i });
      expect(within(list).getAllByRole('link')).toHaveLength(DESTINATIONS.length);
      for (const destination of DESTINATIONS) {
        expect(
          within(list).getByRole('link', { name: new RegExp(destination.label, 'i') }),
        ).toHaveAttribute('href', destination.path);
      }
    });

    it('comes from the destination table rather than a hardcoded list', () => {
      // The same registry the rail and the bottom bar read. A hand-written list
      // here would be the fifth copy of the navigation the epic deleted four of.
      render(<NotFoundPage />, {
        wrapperOptions: { route: '/nope', user: mockAdminUser },
      });

      const list = screen.getByRole('list', { name: /where you can go/i });
      expect(
        within(list)
          .getAllByRole('link')
          .map((link) => link.getAttribute('href')),
      ).toEqual(DESTINATIONS.map((destination) => destination.path));
    });
  });
});
