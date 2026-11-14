/** Every word the bridge's own UI shows (the guide's bubble and the chat panel), per language. */
export interface Messages {
  // The guide's bubble.
  next: string;
  done: string;
  exit: string;
  // The chat panel.
  /** Panel title. */
  title: string;
  /** The round button that opens the panel (read by screen readers). */
  open: string;
  close: string;
  newConversation: string;
  placeholder: string;
  send: string;
  stop: string;
  /** Shown in an empty conversation. */
  greeting: string;
  thinking: string;
  /** While the model searches or reads the product docs. */
  readingDocs: string;
  /** While the model uses any other tool. */
  working: string;
  /** The panel, folded away while a guide is on the page. */
  guiding: string;
  expand: string;
  stopped: string;
  /** After an answer that hit the length limit. */
  cutOff: string;
  failed: string;
  refused: string;
}

const MESSAGES: Record<string, Messages> = {
  en: {
    next: 'Next',
    done: 'Done',
    exit: 'Exit',
    title: 'Help',
    open: 'Open help',
    close: 'Close',
    newConversation: 'New conversation',
    placeholder: 'Ask anything about this page…',
    send: 'Send',
    stop: 'Stop',
    greeting: 'Stuck on something, or not sure how to do it? Ask me. I can see what you just did and will point you to the right place on the page.',
    thinking: 'Thinking…',
    readingDocs: 'Checking the docs…',
    working: 'Working on it…',
    guiding: 'Showing you on the page',
    expand: 'Open',
    stopped: 'Stopped',
    cutOff: '(The answer was cut short.)',
    failed: 'Something went wrong. Please try again.',
    refused: "I can't help with that.",
  },
  zh: {
    next: '下一步',
    done: '完成',
    exit: '退出',
    title: '应用内助手',
    open: '打开助手',
    close: '关闭',
    newConversation: '新对话',
    placeholder: '有问题就问我…',
    send: '发送',
    stop: '停止',
    greeting: '遇到不会的操作或者报错，直接问我。我能看到你刚才做了什么，会在页面上指给你看该怎么做。',
    thinking: '思考中…',
    readingDocs: '正在查文档…',
    working: '处理中…',
    guiding: '正在页面上指给你看',
    expand: '展开',
    stopped: '已停止',
    cutOff: '（回答太长，被截断了）',
    failed: '出错了，请稍后再试。',
    refused: '这个问题我没法回答。',
  },
};

/** Messages for a locale like `zh-CN` (English when the language is not covered), with `overrides` on top. */
export function messagesFor(locale: string | undefined, overrides: Partial<Messages> = {}): Messages {
  const base = MESSAGES[(locale ?? '').toLowerCase().split('-')[0] ?? ''] ?? MESSAGES.en!;
  return { ...base, ...overrides };
}
