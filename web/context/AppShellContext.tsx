"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getStoredTheme,
  getSystemTheme,
  setTheme as applyThemePreference,
  subscribeToThemeChanges,
  type Theme,
} from "@/lib/theme";
import {
  ACTIVE_SESSION_EVENT,
  ACTIVE_SESSION_STORAGE_KEY,
  CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY,
  CODE_BLOCK_SETTINGS_EVENT,
  CODE_BLOCK_THEME_STORAGE_KEY,
  CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY,
  LANGUAGE_EVENT,
  LANGUAGE_STORAGE_KEY,
  PET_EVENT,
  PET_STORAGE_KEY,
  SIDEBAR_COLLAPSED_EVENT,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  normalizeCodeBlockShowLineNumbers,
  normalizeCodeBlockTheme,
  normalizePet,
  normalizeCodeBlockWrapLongLines,
  normalizeLanguage,
  readStoredActiveSessionId,
  readStoredCodeBlockShowLineNumbers,
  readStoredCodeBlockTheme,
  readStoredCodeBlockWrapLongLines,
  readStoredLanguage,
  readStoredPet,
  readStoredSidebarCollapsed,
  writeStoredActiveSessionId,
  writeStoredCodeBlockShowLineNumbers,
  writeStoredCodeBlockTheme,
  writeStoredCodeBlockWrapLongLines,
  writeStoredLanguage,
  writeStoredPet,
  writeStoredSidebarCollapsed,
  type AppLanguage,
} from "@/context/app-shell-storage";
import { DEFAULT_PET_ID } from "@/lib/pets";

interface AppShellContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  activeSessionId: string | null;
  setActiveSessionId: (sessionId: string | null) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  codeBlockTheme: string;
  setCodeBlockTheme: (theme: string) => void;
  codeBlockShowLineNumbers: boolean;
  setCodeBlockShowLineNumbers: (show: boolean) => void;
  codeBlockWrapLongLines: boolean;
  setCodeBlockWrapLongLines: (wrap: boolean) => void;
  /** Ambient companion pet id ("disabled" hides it). */
  pet: string;
  setPet: (pet: string) => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function AppShellProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return getStoredTheme() ?? getSystemTheme();
  });
  // Always start with "en" to match SSR; hydrate from localStorage after mount
  const [language, setLanguageState] = useState<AppLanguage>("en");
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(
    () => readStoredActiveSessionId(),
  );
  // Always start expanded to match SSR; hydrate from localStorage after mount
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(false);
  // Code block settings - start with defaults, hydrate from localStorage after mount
  const [codeBlockTheme, setCodeBlockThemeState] = useState<string>(() =>
    readStoredCodeBlockTheme(),
  );
  const [codeBlockShowLineNumbers, setCodeBlockShowLineNumbersState] =
    useState<boolean>(() => readStoredCodeBlockShowLineNumbers());
  const [codeBlockWrapLongLines, setCodeBlockWrapLongLinesState] =
    useState<boolean>(() => readStoredCodeBlockWrapLongLines());
  // Start with the catalog default to match SSR; hydrate from localStorage
  // after mount (same contract as language).
  const [pet, setPetState] = useState<string>(DEFAULT_PET_ID);

  useEffect(() => {
    // Hydrate client-only preferences after SSR-safe first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLanguageState(readStoredLanguage());
    setSidebarCollapsedState(readStoredSidebarCollapsed());
    setCodeBlockThemeState(readStoredCodeBlockTheme());
    setCodeBlockShowLineNumbersState(readStoredCodeBlockShowLineNumbers());
    setCodeBlockWrapLongLinesState(readStoredCodeBlockWrapLongLines());
    setPetState(readStoredPet());
  }, []);

  useEffect(() => {
    return subscribeToThemeChanges((nextTheme) => {
      setThemeState(nextTheme);
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY) {
        setLanguageState(normalizeLanguage(event.newValue));
      }
      if (event.key === ACTIVE_SESSION_STORAGE_KEY) {
        setActiveSessionIdState(event.newValue);
      }
      if (event.key === SIDEBAR_COLLAPSED_STORAGE_KEY) {
        setSidebarCollapsedState(event.newValue === "1");
      }
      if (event.key === PET_STORAGE_KEY) {
        setPetState(normalizePet(event.newValue));
      }
      if (event.key === CODE_BLOCK_THEME_STORAGE_KEY) {
        setCodeBlockThemeState(normalizeCodeBlockTheme(event.newValue));
      }
      if (event.key === CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY) {
        setCodeBlockShowLineNumbersState(
          normalizeCodeBlockShowLineNumbers(event.newValue),
        );
      }
      if (event.key === CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY) {
        setCodeBlockWrapLongLinesState(
          normalizeCodeBlockWrapLongLines(event.newValue),
        );
      }
    };

    const onLanguage = (event: Event) => {
      const detail = (event as CustomEvent<{ language?: AppLanguage }>).detail;
      setLanguageState(normalizeLanguage(detail?.language));
    };

    const onActiveSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>)
        .detail;
      setActiveSessionIdState(detail?.sessionId ?? null);
    };

    const onSidebarCollapsed = (event: Event) => {
      const detail = (event as CustomEvent<{ collapsed?: boolean }>).detail;
      setSidebarCollapsedState(Boolean(detail?.collapsed));
    };

    const onCodeBlockSettings = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          codeBlockTheme?: string;
          codeBlockShowLineNumbers?: boolean;
          codeBlockWrapLongLines?: boolean;
        }>
      ).detail;

      if (detail?.codeBlockTheme !== undefined) {
        setCodeBlockThemeState(normalizeCodeBlockTheme(detail.codeBlockTheme));
      }
      if (detail?.codeBlockShowLineNumbers !== undefined) {
        setCodeBlockShowLineNumbersState(
          Boolean(detail.codeBlockShowLineNumbers),
        );
      }
      if (detail?.codeBlockWrapLongLines !== undefined) {
        setCodeBlockWrapLongLinesState(Boolean(detail.codeBlockWrapLongLines));
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(LANGUAGE_EVENT, onLanguage);
    window.addEventListener(ACTIVE_SESSION_EVENT, onActiveSession);
    window.addEventListener(SIDEBAR_COLLAPSED_EVENT, onSidebarCollapsed);
    const onPet = (event: Event) => {
      const detail = (event as CustomEvent<{ pet?: string }>).detail;
      if (detail?.pet !== undefined) {
        setPetState(normalizePet(detail.pet));
      }
    };

    window.addEventListener(CODE_BLOCK_SETTINGS_EVENT, onCodeBlockSettings);
    window.addEventListener(PET_EVENT, onPet);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LANGUAGE_EVENT, onLanguage);
      window.removeEventListener(ACTIVE_SESSION_EVENT, onActiveSession);
      window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, onSidebarCollapsed);
      window.removeEventListener(
        CODE_BLOCK_SETTINGS_EVENT,
        onCodeBlockSettings,
      );
      window.removeEventListener(PET_EVENT, onPet);
    };
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    applyThemePreference(nextTheme);
    setThemeState(nextTheme);
  }, []);

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    writeStoredLanguage(nextLanguage);
    setLanguageState(nextLanguage);
  }, []);

  const setActiveSessionId = useCallback((sessionId: string | null) => {
    writeStoredActiveSessionId(sessionId);
    setActiveSessionIdState(sessionId);
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    writeStoredSidebarCollapsed(collapsed);
    setSidebarCollapsedState(collapsed);
  }, []);

  const setCodeBlockTheme = useCallback((nextTheme: string) => {
    const normalizedTheme = normalizeCodeBlockTheme(nextTheme);
    writeStoredCodeBlockTheme(normalizedTheme);
    setCodeBlockThemeState(normalizedTheme);
  }, []);

  const setCodeBlockShowLineNumbers = useCallback((show: boolean) => {
    writeStoredCodeBlockShowLineNumbers(show);
    setCodeBlockShowLineNumbersState(show);
  }, []);

  const setCodeBlockWrapLongLines = useCallback((wrap: boolean) => {
    writeStoredCodeBlockWrapLongLines(wrap);
    setCodeBlockWrapLongLinesState(wrap);
  }, []);

  const setPet = useCallback((nextPet: string) => {
    const normalizedPet = normalizePet(nextPet);
    writeStoredPet(normalizedPet);
    setPetState(normalizedPet);
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({
      theme,
      setTheme,
      language,
      setLanguage,
      activeSessionId,
      setActiveSessionId,
      sidebarCollapsed,
      setSidebarCollapsed,
      codeBlockTheme,
      setCodeBlockTheme,
      codeBlockShowLineNumbers,
      setCodeBlockShowLineNumbers,
      codeBlockWrapLongLines,
      setCodeBlockWrapLongLines,
      pet,
      setPet,
    }),
    [
      activeSessionId,
      codeBlockShowLineNumbers,
      codeBlockTheme,
      codeBlockWrapLongLines,
      language,
      setActiveSessionId,
      setCodeBlockShowLineNumbers,
      setCodeBlockTheme,
      pet,
      setPet,
      setCodeBlockWrapLongLines,
      setLanguage,
      setSidebarCollapsed,
      setTheme,
      sidebarCollapsed,
      theme,
    ],
  );

  return (
    <AppShellContext.Provider value={value}>
      {children}
    </AppShellContext.Provider>
  );
}

export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error("useAppShell must be used inside AppShellProvider");
  }
  return context;
}
