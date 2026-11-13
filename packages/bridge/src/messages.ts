/** The few words the bridge's own UI shows, per language. */
export interface Messages {
  next: string;
  done: string;
  exit: string;
}

const MESSAGES: Record<string, Messages> = {
  en: { next: 'Next', done: 'Done', exit: 'Exit' },
  zh: { next: '下一步', done: '完成', exit: '退出' },
};

/** Messages for a locale like `zh-CN`; English when the language is not covered. */
export function messagesFor(locale: string | undefined): Messages {
  return MESSAGES[(locale ?? '').toLowerCase().split('-')[0] ?? ''] ?? MESSAGES.en!;
}
