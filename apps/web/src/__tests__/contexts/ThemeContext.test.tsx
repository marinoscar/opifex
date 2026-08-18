import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeContextProvider, useThemeContext } from '../../contexts/ThemeContext';

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset matchMedia mock to default (light mode)
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as any);
  });

  describe('Initial State', () => {
    it('should default to system preference', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
    });

    it('should load saved preference from localStorage', () => {
      localStorage.setItem('theme_mode', 'dark');

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('dark');
    });

    it('should ignore invalid localStorage values', () => {
      localStorage.setItem('theme_mode', 'invalid');

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
    });
  });

  describe('Theme Switching', () => {
    it('should switch to dark mode', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
      });

      expect(result.current.mode).toBe('dark');
      expect(result.current.theme.palette.mode).toBe('dark');
      expect(result.current.isDarkMode).toBe(true);
    });

    it('should switch to light mode', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('light');
      });

      expect(result.current.mode).toBe('light');
      expect(result.current.theme.palette.mode).toBe('light');
      expect(result.current.isDarkMode).toBe(false);
    });

    it('should switch to system mode', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
        result.current.setMode('system');
      });

      expect(result.current.mode).toBe('system');
    });

    it('should toggle between light and dark', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      // Start with light
      act(() => {
        result.current.setMode('light');
      });
      expect(result.current.isDarkMode).toBe(false);

      // Toggle to dark
      act(() => {
        result.current.toggleMode();
      });
      expect(result.current.isDarkMode).toBe(true);
      expect(result.current.mode).toBe('dark');

      // Toggle back to light
      act(() => {
        result.current.toggleMode();
      });
      expect(result.current.isDarkMode).toBe(false);
      expect(result.current.mode).toBe('light');
    });

    it('should persist preference to localStorage', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      act(() => {
        result.current.setMode('dark');
      });

      expect(localStorage.getItem('theme_mode')).toBe('dark');

      act(() => {
        result.current.setMode('light');
      });

      expect(localStorage.getItem('theme_mode')).toBe('light');
    });
  });

  describe('System Preference', () => {
    it('should use system dark mode when system is dark', () => {
      vi.mocked(window.matchMedia).mockReturnValue({
        matches: true, // prefers-color-scheme: dark
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as any);

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
      expect(result.current.isDarkMode).toBe(true);
      expect(result.current.theme.palette.mode).toBe('dark');
    });

    it('should use system light mode when system is light', () => {
      vi.mocked(window.matchMedia).mockReturnValue({
        matches: false, // prefers-color-scheme: light
        media: '(prefers-color-scheme: light)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as any);

      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.mode).toBe('system');
      expect(result.current.isDarkMode).toBe(false);
      expect(result.current.theme.palette.mode).toBe('light');
    });
  });

  describe('Theme Object', () => {
    it('should provide valid MUI theme object', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      expect(result.current.theme).toBeDefined();
      expect(result.current.theme.palette).toBeDefined();
      expect(result.current.theme.typography).toBeDefined();
      expect(result.current.theme.spacing).toBeDefined();
    });

    it('should update theme when mode changes', () => {
      const { result } = renderHook(() => useThemeContext(), {
        wrapper: ThemeContextProvider,
      });

      const lightTheme = result.current.theme;

      act(() => {
        result.current.setMode('dark');
      });

      const darkTheme = result.current.theme;

      expect(darkTheme).not.toBe(lightTheme);
      expect(darkTheme.palette.mode).toBe('dark');
    });
  });

  describe('Context Usage', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useThemeContext());
      }).toThrow('useThemeContext must be used within a ThemeContextProvider');

      consoleSpy.mockRestore();
    });
  });
});
