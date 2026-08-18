import { ReactNode } from 'react';
import { vi } from 'vitest';
import { ThemeProvider } from '@mui/material/styles';
import { lightTheme, darkTheme } from '../../theme';

// Theme Context Mock
export const mockThemeContext = {
  mode: 'light' as const,
  theme: lightTheme,
  setMode: vi.fn(),
  toggleTheme: vi.fn(),
};

export function MockThemeProvider({
  children,
  mode = 'light',
}: {
  children: ReactNode;
  mode?: 'light' | 'dark';
}) {
  const theme = mode === 'light' ? lightTheme : darkTheme;
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

// Auth Context Mock
export interface MockAuthContextValue {
  user: any | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  providers: any[];
  login: () => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const createMockAuthContext = (
  overrides: Partial<MockAuthContextValue> = {},
): MockAuthContextValue => ({
  user: null,
  isLoading: false,
  isAuthenticated: false,
  providers: [],
  login: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  refreshUser: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

// Snackbar/Notification Mock
export const mockSnackbar = {
  enqueueSnackbar: vi.fn(),
  closeSnackbar: vi.fn(),
};

// Router Mock Utilities
export const mockNavigate = vi.fn();
export const mockLocation = {
  pathname: '/',
  search: '',
  hash: '',
  state: null,
  key: 'default',
};

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation,
  };
});
