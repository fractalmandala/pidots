import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import {
  computerInputs,
  computerPermissionsSchema,
  insidePath,
  reservedComputerPaths,
  type ComputerAction,
  type ComputerControl,
  type ComputerFolder,
  type ComputerStatus,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { PlatformConfig } from './platform-config.js';
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
  /** Provisioning progress while the provider prepares the computer. */
  message: z.string().max(500).optional(),
});
/**
 * Resolves a folder or file the owner wants to share to its real absolute
 * path. The computer mounts it at that same path, so it must not cover or
 * replace any system or service path inside the VM.
 */
export async function sharedPath(input: string) {
  if (
    !input ||
    input.length > 1024 ||
    !isAbsolute(input) ||
    [...input].some((char) => char.charCodeAt(0) < 0x20)
  )
    throw new Error('Choose a folder or file by its full path.');
  let path: string;
  let info;
  try {
    path = await realpath(normalize(input));
    info = await stat(path);
  } catch {
    throw new Error(`${input} does not exist.`);
  }
  if (!info.isDirectory() && !info.isFile())
    throw new Error(`${input} is not a folder or file.`);
  if (
    reservedComputerPaths.some(
      (reserved) => insidePath(path, reserved) || insidePath(reserved, path),
    )
  )
    throw new Error(
      `${path} can't be shared: it would cover system folders inside the computer.`,
    );
  return { path, kind: info.isDirectory() ? 'directory' : 'file' } as const;
}
/** True when an absolute computer path is inside one of the shared folders. */
export function inSharedFolder(path: string, folders: ComputerFolder[]) {
  const target = normalize(path).replace(/(.)\/$/, '$1');
  return folders.some((folder) => insidePath(target, folder.path));
}
/**
 * Saves an agent screenshot as a PNG on the host and returns the result with
 * only a path reference, so no base64 image is ever stored in a transcript.
 */
export async function storeScreenshot(
  dir: string | undefined,
  dotId: string,
  result: unknown,
): Promise<unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return result;
  const { base64, ...rest } = result as Record<string, unknown>;
  if (typeof base64 !== 'string') return result;
  if (!dir || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dotId))
    return { ...rest, note: 'Screenshot taken but not stored.' };
  const folder = join(dir, dotId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  await writeFile(path, Buffer.from(base64, 'base64'), { mode: 0o600 });
  return { ...rest, path };
}
const controlSchema = z.object({
  holder: z.enum(['bot', 'human']),
  requested: z.boolean(),
  transitioning: z.boolean(),
  resumeSnapshotRequired: z.boolean(),
  request: z.object({ id: z.string(), status: z.string() }).optional(),
});
export class ComputerService {
  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private paused: () => boolean,
    private transport: typeof fetch = fetch,
    private deadlineMs = 70000,
    private startWaitMs = 60000,
    private pollMs = 500,
  ) {}
  get configured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }
  private token(id: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`pidots-computer:${id}`)
      .digest('hex');
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new Error('Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || (kind && !policy[kind]))
      throw new Error('Computer permission is disabled.');
    if (actor === 'agent' && this.paused())
      throw new Error('Agents are paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(dotId ? { 'x-pidots-dot-id': dotId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (response.status === 409)
        throw new Error(
          'Computer service returned HTTP 409: refresh the browser with computer_snapshot before retrying. If the owner has control, wait for them to release it; do not bypass takeover.',
        );
      if (!response.ok)
        throw new Error(`Computer service returned HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Computer service returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Computer response exceeded its size limit.');
        }
        chunks.push(value);
      }
      // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ])
        if (secret) text = text.split(secret).join('[redacted]');
      return JSON.parse(text);
    } catch (error) {
      if (combined.aborted)
        throw new Error('Computer request was cancelled or timed out.', {
          cause: error,
        });
      if (
        error instanceof Error &&
        /^Computer (service returned|response exceeded)/.test(error.message)
      )
        throw error;
      throw new Error(
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private supervisor(path: string, body?: unknown, signal?: AbortSignal) {
    return this.json(
      `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
      this.config.computerSupervisorToken!.trim(),
      body,
      signal,
    );
  }
  private endpoint(id: string, raw: unknown) {
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'pidots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new Error('Computer identity mismatch.');
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expected}:4100`),
    );
    const network =
      url.hostname === expected.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new Error('Computer endpoint is not bound to this Dot.');
    return url.origin;
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = z
      .object({ computers: z.array(stateSchema) })
      .parse(await this.supervisor('/computers', undefined, signal));
    return listing.computers.find((c) => c.botId === id);
  }
  /**
   * The Dot's endpoint, starting it on first use: the shared computer boots
   * lazily and stops itself when idle, so a tool call simply waits for it.
   */
  private async running(id: string, signal?: AbortSignal) {
    let state = await this.existing(id, signal);
    if (state?.status === 'running') return this.endpoint(id, state);
    await this.ensure(id);
    const until = Date.now() + this.startWaitMs;
    for (;;) {
      state = await this.existing(id, signal);
      if (state?.status === 'running') return this.endpoint(id, state);
      if (state?.status === 'failed')
        throw new Error(state.message ?? 'The computer could not start.');
      if (Date.now() >= until)
        throw new Error(
          `The computer is still starting${state?.message ? ` (${state.message})` : ''}. Try again in a minute.`,
        );
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const base = {
      configured: this.configured,
      permissions: this.workspace.computers.permissions(id),
      folders: this.workspace.computers.folders(id),
      audit: this.workspace.computers.audit(id),
    };
    if (!this.configured) return { ...base, state: 'not_configured' };
    try {
      const state = await this.existing(id);
      if (state?.status === 'preparing')
        return { ...base, state: 'preparing', progress: state.message };
      if (state?.status === 'failed')
        return {
          ...base,
          state: 'stopped',
          error: state.message ?? 'The computer could not start.',
        };
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = this.endpoint(id, state);
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return { ...base, state: 'running', control };
    } catch {
      return {
        ...base,
        state: 'unavailable',
        error:
          'Computer service is unavailable. Check the supervisor configuration and connection.',
      };
    }
  }
  private async audited<T>(
    id: string,
    action: string,
    actor: 'owner' | 'agent',
    fn: () => Promise<T>,
  ): Promise<T> {
    this.requireDot(id);
    const receipt = this.workspace.computers.begin(id, action, actor);
    try {
      const result = await fn();
      this.workspace.computers.finish(receipt, 'succeeded');
      return result;
    } catch (error) {
      this.workspace.computers.finish(receipt, 'failed');
      throw error;
    }
  }
  async permissions(id: string, input: unknown) {
    const patch = computerPermissionsSchema.partial().parse(input);
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      this.allowed(id, undefined, 'owner');
      // First-time setup can take minutes; the provider answers at once with
      // `preparing` and the panel polls status until it is running.
      await this.ensure(id);
    });
    return this.status(id);
  }
  /** Boots the computer with the Dot's shared folders mounted at their own paths. */
  private async ensure(id: string) {
    // A folder deleted since it was shared would stop the computer booting.
    const mounts = this.workspace.computers
      .folders(id)
      .filter(({ path }) => existsSync(path))
      .map(({ path }) => ({ source: path, destination: path }));
    const state = stateSchema.parse(
      await this.supervisor(`/computers/${id}/ensure`, { mounts }),
    );
    if (state.status === 'running') this.endpoint(id, state);
  }
  /**
   * Shares folders or files from the owner's Mac with this Dot. The shared
   * computer mounts every Dot's folders at boot, so the Dot's service restarts
   * and the provider reboots the VM if no other Dot is using it (otherwise
   * the new folders apply at the next restart; status says so).
   */
  async addFolders(id: string, paths: string[]) {
    this.requireDot(id);
    const resolved = await Promise.all(paths.map(sharedPath));
    await this.audited(id, 'share_folder', 'owner', async () => {
      for (const { path, kind } of resolved)
        this.workspace.computers.addFolder(id, path, kind);
      await this.applyFolders(id);
    });
    return this.status(id);
  }
  async removeFolder(id: string, path: string) {
    this.requireDot(id);
    await this.audited(id, 'unshare_folder', 'owner', async () => {
      if (!this.workspace.computers.removeFolder(id, path))
        throw new Error('That folder is not shared with this Dot.');
      await this.applyFolders(id);
    });
    return this.status(id);
  }
  private async applyFolders(id: string) {
    if (!this.configured) return;
    const state = await this.existing(id);
    if (state?.status !== 'running' && state?.status !== 'preparing') return;
    await this.supervisor(`/computers/${id}/stop`, {});
    await this.ensure(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      await this.supervisor(`/computers/${id}/stop`, {});
    });
    return this.status(id);
  }
  /** Removes the Dot's user from the shared computer; its workspace files are lost. */
  async delete(id: string) {
    await this.audited(id, 'delete', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      await this.supervisor(`/computers/${id}/delete`, {});
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      let control: ComputerControl = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      if (verb === 'take' && !control.request)
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (
        verb === 'take' &&
        control.request &&
        !['waiting', 'taken'].includes(control.request.status)
      )
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (!control.request)
        throw new Error('There is no active control request.');
      await this.json(
        `${url}/control/${verb}`,
        this.token(id),
        { requestId: control.request.id },
        undefined,
        id,
      );
    });
    return this.status(id);
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(computerInputs, action))
      throw new Error('Unknown computer action.');
    const parsed = computerInputs[action].parse(input);
    return this.audited(id, action, actor, async () => {
      if (actor === 'agent' && action.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind =
        action === 'exec'
          ? 'shell'
          : action.startsWith('files_')
            ? 'files'
            : 'browser';
      this.allowed(id, kind, actor);
      const target =
        kind === 'files' ? (parsed as { path?: string }).path : undefined;
      if (
        target?.startsWith('/') &&
        !inSharedFolder(target, this.workspace.computers.folders(id))
      )
        throw new Error(
          'That path is not in a folder shared with this Dot. Use a path relative to the workspace, or ask the owner to share the folder.',
        );
      const cancellation = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      const watcher = setInterval(() => {
        try {
          this.allowed(id, kind, actor);
        } catch {
          cancellation.abort();
        }
      }, 50);
      try {
        const url = await this.running(id, activeSignal);
        this.allowed(id, kind, actor);
        activeSignal.throwIfAborted();
        const path = action
          .replace(/^files_/, 'files/')
          .replace(/^human_/, 'human/');
        const result = await this.json(
          `${url}/${path}`,
          this.token(id),
          ['read', 'screenshot'].includes(action) ? undefined : parsed,
          activeSignal,
          id,
        );
        this.allowed(id, kind, actor);
        if (action === 'exec' && result && typeof result === 'object') {
          const copy = { ...result } as Record<string, unknown>;
          delete copy.command;
          return copy;
        }
        if (action === 'screenshot' && actor === 'agent')
          return storeScreenshot(this.config.computerScreenshotDir, id, result);
        return result;
      } finally {
        clearInterval(watcher);
      }
    });
  }
}
