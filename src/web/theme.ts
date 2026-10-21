export type Theme = 'system' | 'light' | 'dark';

const key = 'feedlantern:theme';
export const themeLabels: Record<Theme, string> = { system: '跟随系统', light: '亮色', dark: '暗色' };

export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    if (theme === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, theme);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
}
