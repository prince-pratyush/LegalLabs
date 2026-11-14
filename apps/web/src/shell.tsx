import { createContext, type ReactNode, useContext } from "react";

export interface ShellProps {
  /** The screen's own side panel; an open citation takes its place. */
  panel?: ReactNode;
  onTogglePanel?: () => void;
  children: ReactNode;
}

// Screens render their content into the app frame without knowing about the sidebar.
export const ShellContext = createContext<(props: ShellProps) => ReactNode>(
  ({ children }) => children,
);

export function Shell(props: ShellProps) {
  return useContext(ShellContext)(props);
}
