import type { BrowserContext, Page } from 'playwright-core';
import type { Control } from './control.js';

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

const VIEWPORT = { width: 1280, height: 800 };
const TEXT_LIMIT = 40_000;

/**
 * Tags visible interactive elements with refs scoped to one snapshot, so a
 * click or type always targets what the Dot last saw and stale refs fail.
 */
function tagElements(snapshot: number) {
  const selector =
    'a[href],button,input,textarea,select,summary,[role],[onclick],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const elements: {
    ref: string;
    role: string;
    name: string;
    value?: string;
  }[] = [];
  let index = 0;
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>(selector),
  )) {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      box.width === 0 ||
      box.height === 0 ||
      style.visibility === 'hidden' ||
      style.display === 'none'
    )
      continue;
    const ref = `e${++index}`;
    element.setAttribute('data-pidots-ref', ref);
    element.setAttribute('data-pidots-snapshot', String(snapshot));
    const tag = element.tagName.toLowerCase();
    const role =
      element.getAttribute('role') ??
      (tag === 'a'
        ? 'link'
        : tag === 'input'
          ? `textbox:${(element as HTMLInputElement).type}`
          : tag === 'textarea'
            ? 'textbox'
            : tag === 'select'
              ? 'combobox'
              : tag);
    const name = (
      element.getAttribute('aria-label') ??
      element.getAttribute('title') ??
      element.getAttribute('placeholder') ??
      element.innerText ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
        ? element.type === 'password'
          ? undefined
          : element.value.slice(0, 120)
        : undefined;
    elements.push({ ref, role, name, ...(value ? { value } : {}) });
    if (elements.length >= 400) break;
  }
  return elements;
}

export class Browser {
  private context?: BrowserContext;
  private snapshotId = 0;
  private snapshotValid = false;

  constructor(
    private options: {
      executablePath: string;
      profileDir: string;
      control: Control;
      launch?: (options: {
        executablePath: string;
        profileDir: string;
      }) => Promise<BrowserContext>;
    },
  ) {}

  private async page(): Promise<Page> {
    if (!this.context || !this.context.browser()?.isConnected?.()) {
      const launch =
        this.options.launch ??
        (async ({ executablePath, profileDir }) => {
          const { chromium } = await import('playwright-core');
          return chromium.launchPersistentContext(profileDir, {
            executablePath,
            headless: true,
            viewport: VIEWPORT,
            // The VM is the isolation boundary; Chromium's own sandbox needs
            // privileges the unprivileged guest user does not have.
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
          });
        });
      this.context = await launch(this.options);
    }
    return this.context.pages()[0] ?? (await this.context.newPage());
  }

  private agentAction() {
    this.options.control.requireBot();
    this.options.control.requireFreshSnapshot();
  }

  private target(page: Page, ref: string, snapshotId: number) {
    if (!this.snapshotValid || snapshotId !== this.snapshotId)
      throw new BrowserError(
        'This snapshot is stale. Take computer_snapshot and use its refs.',
        409,
      );
    return page.locator(
      `[data-pidots-ref="${ref.replace(/[^a-z0-9]/gi, '')}"][data-pidots-snapshot="${snapshotId}"]`,
    );
  }

  async navigate(url: string, actor: 'agent' | 'owner' = 'agent') {
    if (actor === 'agent') this.options.control.requireBot();
    const page = await this.page();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    this.snapshotValid = false;
    return {
      url: page.url(),
      title: await page.title(),
      status: response?.status() ?? null,
    };
  }

  async read() {
    const page = await this.page();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return {
      url: page.url(),
      title: await page.title(),
      text: text.slice(0, TEXT_LIMIT),
      truncated: text.length > TEXT_LIMIT,
    };
  }

  async snapshot() {
    this.options.control.requireBot();
    const page = await this.page();
    const snapshotId = ++this.snapshotId;
    const elements = (await page.evaluate(
      tagElements,
      snapshotId,
    )) as SnapshotElement[];
    this.snapshotValid = true;
    this.options.control.snapshotTaken();
    return {
      snapshotId,
      url: page.url(),
      title: await page.title(),
      elements,
    };
  }

  async screenshot() {
    const page = await this.page();
    const image = await page.screenshot({ type: 'png' });
    const size = page.viewportSize() ?? VIEWPORT;
    return {
      base64: image.toString('base64'),
      width: size.width,
      height: size.height,
      url: page.url(),
      capturedAt: Date.now(),
    };
  }

  async click(ref: string, snapshotId: number) {
    this.agentAction();
    const page = await this.page();
    await this.target(page, ref, snapshotId).click({ timeout: 10_000 });
    this.snapshotValid = false;
    return { clicked: ref, url: page.url() };
  }

  async type(ref: string, snapshotId: number, text: string, submit = false) {
    this.agentAction();
    const page = await this.page();
    const target = this.target(page, ref, snapshotId);
    await target.fill(text, { timeout: 10_000 });
    if (submit) await target.press('Enter');
    this.snapshotValid = false;
    return { typed: ref, submitted: submit, url: page.url() };
  }

  async key(key: string, actor: 'agent' | 'owner' = 'agent') {
    if (actor === 'agent') this.agentAction();
    const page = await this.page();
    await page.keyboard.press(key);
    this.snapshotValid = false;
    return { key };
  }

  async scroll(deltaY: number, actor: 'agent' | 'owner' = 'agent') {
    if (actor === 'agent') this.agentAction();
    const page = await this.page();
    await page.mouse.wheel(0, deltaY);
    return { deltaY };
  }

  /** Owner input while holding control. */
  async humanClick(x: number, y: number) {
    const page = await this.page();
    await page.mouse.click(x, y);
    this.snapshotValid = false;
    return { x, y };
  }

  async humanType(text: string) {
    const page = await this.page();
    await page.keyboard.type(text);
    this.snapshotValid = false;
    return { typed: text.length };
  }

  async close() {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
  }
}
