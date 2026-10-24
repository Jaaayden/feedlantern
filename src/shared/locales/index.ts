/**
 * Registered languages. To add one, translate `en.ts` into a new file and
 * add one entry here; `code` is its BCP 47 tag and `name` its own name.
 */
import en from './en.js';
import zhCN from './zh-CN.js';

export const catalogs = {
  en: { code: 'en', name: 'English', messages: en },
  'zh-CN': { code: 'zh-CN', name: '简体中文', messages: zhCN },
} as const;
