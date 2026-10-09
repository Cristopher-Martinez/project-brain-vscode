import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  type ReactNode,
} from "react";
import { useExtensionMessage } from "../hooks/useExtensionMessage";
import { createMessageHandler } from "./messageHandler";
import { initialState, reducer } from "./reducer";

// Re-export AppState so consumers keep importing from this module
export type { AppState } from "./reducer";

//  Context

interface AppContextType {
  state: ReturnType<typeof reducer> extends infer S ? S : never;
  dispatch: React.Dispatch<Parameters<typeof reducer>[1]>;
}

const AppContext = createContext<AppContextType | null>(null);

export function useAppState(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppState must be used within AppProvider");
  return ctx;
}

//  Provider

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const handleMessage = useCallback(createMessageHandler(dispatch), []);
  useExtensionMessage(handleMessage);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}
