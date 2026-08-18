import { renderHook, RenderHookOptions, RenderHookResult } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { lightTheme } from '../../theme';

interface HookWrapperOptions {
  route?: string;
}

export function createHookWrapper(options: HookWrapperOptions = {}) {
  const { route = '/' } = options;

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider theme={lightTheme}>
          {children}
        </ThemeProvider>
      </MemoryRouter>
    );
  };
}

export function renderHookWithProviders<TResult, TProps>(
  hook: (props: TProps) => TResult,
  options: RenderHookOptions<TProps> & { wrapperOptions?: HookWrapperOptions } = {},
): RenderHookResult<TResult, TProps> {
  const { wrapperOptions, ...renderOptions } = options;

  return renderHook(hook, {
    wrapper: createHookWrapper(wrapperOptions),
    ...renderOptions,
  });
}
