import { z } from 'zod';
export const computerPermissionsSchema = z
  .object({
    enabled: z.boolean(),
    browser: z.boolean(),
    files: z.boolean(),
    shell: z.boolean(),
  })
  .strict();
export type ComputerPermissions = z.infer<typeof computerPermissionsSchema>;
export interface ComputerAudit {
  id: string;
  action: string;
  actor: 'owner' | 'agent';
  outcome: 'pending' | 'succeeded' | 'failed';
  createdAt: number;
}
export interface ComputerControl {
  holder: 'bot' | 'human';
  requested: boolean;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  request?: { id: string; status: string };
}
/** A folder or file on the owner's Mac shared read-write into a Dot's computer. */
export interface ComputerFolder {
  /** Absolute host path; the computer sees it at the same path. */
  path: string;
  kind: 'directory' | 'file';
  addedAt: number;
}
export interface ComputerStatus {
  configured: boolean;
  state: 'not_configured' | 'stopped' | 'preparing' | 'running' | 'unavailable';
  /** First-time setup progress while `preparing`. */
  progress?: string;
  permissions: ComputerPermissions;
  folders: ComputerFolder[];
  audit: ComputerAudit[];
  control?: ComputerControl;
  error?: string;
}
/**
 * Guest paths that shared folders may never cover or replace: the system,
 * the computer service, and the Dot's own home.
 */
export const reservedComputerPaths = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
];
/** True when `path` is `root` or inside it (both absolute, normalized). */
export function insidePath(path: string, root: string) {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}
/**
 * Workspace paths are relative to /home/dot/workspace. Absolute paths are
 * allowed only inside a folder the owner shared; the broker checks that.
 */
const path = z
  .string()
  .max(1024)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.includes('\0') &&
      !p.split('/').some((s) => s === '..'),
    'Use a workspace path, or a shared folder path, without traversal.',
  );
const empty = z.object({}).strict();
const ref = {
  ref: z.string().min(1).max(100),
  snapshotId: z.number().int().nonnegative(),
};
export const computerInputs = {
  navigate: z
    .object({
      url: z
        .string()
        .url()
        .max(2048)
        .refine(
          (s) =>
            ['http:', 'https:'].includes(new URL(s).protocol) &&
            !new URL(s).username &&
            !new URL(s).password,
        ),
    })
    .strict(),
  read: empty,
  snapshot: empty,
  screenshot: empty,
  click: z.object(ref).strict(),
  type: z
    .object({
      ...ref,
      text: z.string().max(16000),
      submit: z.boolean().optional(),
    })
    .strict(),
  key: z.object({ key: z.string().min(1).max(100) }).strict(),
  scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
  files_list: z.object({ path: path.default('') }).strict(),
  files_read: z.object({ path: path.refine((p) => p.length > 0) }).strict(),
  files_write: z
    .object({
      path: path.refine((p) => p.length > 0),
      contents: z.string().max(100000),
      append: z.boolean().optional(),
    })
    .strict(),
  exec: z
    .object({
      command: z.string().trim().min(1).max(8000),
      timeoutMs: z.number().int().min(1000).max(60000).default(30000),
    })
    .strict(),
  human_click: z
    .object({
      x: z.number().finite().min(0).max(16000),
      y: z.number().finite().min(0).max(16000),
    })
    .strict(),
  human_type: z.object({ text: z.string().max(16000) }).strict(),
  human_key: z.object({ key: z.string().min(1).max(100) }).strict(),
  human_scroll: z
    .object({ deltaY: z.number().finite().min(-10000).max(10000) })
    .strict(),
};
export type ComputerAction = keyof typeof computerInputs;
