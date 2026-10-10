import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import type { Engine } from './engine/engine.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import type { MessageSource } from '../shared/thread-types.js';

/** The services behind the API, built from the current provider settings. */
export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly engine: Engine,
  ) {
    engine.setConfig(config);
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.pages = new PageService(workspace, engine);
  }
  setup() {
    return setupStatus(this.config);
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }
  history(threadId: string): Promise<string> {
    this.workspace.requireThread(threadId);
    return this.engine.historyText(threadId);
  }
  turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    source?: MessageSource,
  ): Promise<string> {
    this.requireReady();
    return this.engine.turn(threadId, prompt, signal, source);
  }
}
