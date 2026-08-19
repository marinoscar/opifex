import { Box, useMediaQuery, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { AppBar } from '../navigation/AppBar';
import { NavigationRail } from '../navigation/NavigationRail';
import { BottomNav } from '../navigation/BottomNav';

/**
 * The app shell — two navigation treatments, one per size class.
 *
 * Epic #19 (issues #71 and #72). The `Sidebar` drawer this used to mount is
 * gone from every breakpoint:
 *
 *   compact (< sm)  →  bottom bar only. No drawer, no hamburger, and so NO
 *                      DRAWER STATE TO MANAGE — which is why this component no
 *                      longer holds any, and why the `setTimeout` that used to
 *                      sequence navigation behind the drawer's close animation
 *                      is gone with it.
 *   medium  (sm–lg) →  a permanent collapsed rail (56px). Always visible, so
 *                      navigating costs zero taps instead of one.
 *   expanded (≥ lg) →  the same rail, expanded to 220px with labelled rows.
 *
 * The chrome is chosen by MOUNTING, not by rendering-then-hiding: exactly one
 * navigation surface exists in the tree at any width, so a resize across `sm`
 * swaps it rather than briefly showing two.
 */
export function Layout() {
  const theme = useTheme();
  // 600px, NOT 900px. This is Material 3's compact/medium window-class
  // boundary — compact < 600dp, medium 600–840dp — and M3 is explicit that a
  // rail is the correct chrome from medium upward. Gating at MUI's `md`
  // (900px) would hand the PHONE treatment to every 600–899px device: tablets
  // in portrait (iPad 768px, iPad Pro 11" 834px), foldables unfolded, and
  // phones in landscape.
  //
  // ⚠️ THREE GATES ARE COUPLED AND MUST MOVE TOGETHER. Moving the rail alone
  // renders two navigation surfaces, or none, in the gap:
  //   1. this `showRail`                    — the rail itself
  //   2. `BottomNav`'s `down('sm')`         — the EXACT complement
  //   3. `<main>`'s `pb` below              — clears the fixed bottom bar, and
  //                                           so is only needed where the bar
  //                                           exists
  // This comment is the invariant's only enforcement; there is deliberately no
  // shared constant, because a constant would let (3) drift while still
  // compiling. If you change one number here, change all three.
  const showRail = useMediaQuery(theme.breakpoints.up('sm'));

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // The shell is the ONLY owner of viewport height — pages must not nest
        // their own 100vh inside it, or the document is always at least
        // 100vh + AppBar tall and scrolls even when the content fits. `100dvh`
        // tracks mobile browser chrome; plain `100vh` measures against the
        // LARGEST viewport, so a collapsing URL bar adds jitter. The `100vh`
        // below is the fallback for browsers without dvh support.
        minHeight: '100vh',
        '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
        backgroundColor: theme.palette.background.default,
      }}
    >
      <AppBar />
      {/* `minWidth: 0` on the ROW as well as on `<main>`: the row is itself a
          flex item of the column above, and a runaway intrinsic width
          propagates through every level that omits it. */}
      <Box sx={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
        {/* Focus order follows visual order: rail, then main — which is also
            their DOM order here, so no tabindex juggling is needed. */}
        {showRail && <NavigationRail />}
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            // Load-bearing, not cosmetic. A flex item's `min-width` defaults to
            // `auto` — its min-content width — so without this, any descendant
            // reporting a large intrinsic inline size (a wide table, a long
            // unbroken string) cannot be shrunk and widens the whole app shell
            // past the viewport. This is also what a DataTable embedded in this
            // flex child requires of its host.
            minWidth: 0,
            p: 3,
            // Clears the fixed bottom bar, which only exists below `sm` — the
            // same breakpoint `BottomNav` gates on. Keeping this coupled is what
            // stops 600–899px from carrying 80px of padding for a bar that is
            // not mounted there.
            pb: { xs: 10, sm: 3 },
          }}
        >
          <Outlet />
        </Box>
      </Box>
      {/* Mounted only where it renders. `BottomNav` also gates itself on
          `down('sm')` — belt and braces, since a self-gating-but-always-mounted
          bar would still run its hooks at every width. `!showRail` is the exact
          complement of the rail's gate, so there is no width with two navs and
          none with zero. */}
      {!showRail && <BottomNav />}
    </Box>
  );
}
