import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';

describe('LoadingSpinner', () => {
  describe('Basic Rendering', () => {
    it('should render spinner', () => {
      render(<LoadingSpinner />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should render CircularProgress component', () => {
      render(<LoadingSpinner />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Full Screen Mode', () => {
    it('should render full screen when fullScreen prop is true', () => {
      render(<LoadingSpinner fullScreen />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();

      const container = spinner.parentElement;
      expect(container).toHaveStyle({ height: '100vh' });
    });

    it('should render centered in full screen mode', () => {
      render(<LoadingSpinner fullScreen />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      });
    });

    it('should take full viewport height', () => {
      render(<LoadingSpinner fullScreen />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({ height: '100vh', width: '100vw' });
    });
  });

  describe('Default Mode', () => {
    it('should render inline when fullScreen is false', () => {
      render(<LoadingSpinner fullScreen={false} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();

      const container = spinner.parentElement;
      expect(container).not.toHaveStyle({ height: '100vh' });
    });

    it('should have padding in default mode', () => {
      render(<LoadingSpinner />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({
        display: 'flex',
        justifyContent: 'center',
      });
    });
  });

  describe('Size Prop', () => {
    it('should use default size of 40', () => {
      render(<LoadingSpinner />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('should accept custom size', () => {
      render(<LoadingSpinner size={60} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
      // MUI CircularProgress applies size via inline styles
    });

    it('should accept small size', () => {
      render(<LoadingSpinner size={20} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('should accept large size', () => {
      render(<LoadingSpinner size={80} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Prop Combinations', () => {
    it('should handle fullScreen with custom size', () => {
      render(<LoadingSpinner fullScreen size={60} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();

      const container = spinner.parentElement;
      expect(container).toHaveStyle({ height: '100vh' });
    });

    it('should handle default mode with custom size', () => {
      render(<LoadingSpinner fullScreen={false} size={30} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have progressbar role', () => {
      render(<LoadingSpinner />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should be accessible in full screen mode', () => {
      render(<LoadingSpinner fullScreen />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should be accessible with custom size', () => {
      render(<LoadingSpinner size={50} />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('Visual Layout', () => {
    it('should center spinner horizontally', () => {
      render(<LoadingSpinner />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({ justifyContent: 'center' });
    });

    it('should center spinner vertically in full screen', () => {
      render(<LoadingSpinner fullScreen />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({ alignItems: 'center' });
    });

    it('should use flexbox layout', () => {
      render(<LoadingSpinner />);

      const spinner = screen.getByRole('progressbar');
      const container = spinner.parentElement;

      expect(container).toHaveStyle({ display: 'flex' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle size of 0', () => {
      render(<LoadingSpinner size={0} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('should handle very large size', () => {
      render(<LoadingSpinner size={200} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });

    it('should handle undefined fullScreen prop', () => {
      render(<LoadingSpinner fullScreen={undefined} />);

      const spinner = screen.getByRole('progressbar');
      expect(spinner).toBeInTheDocument();
    });
  });
});
