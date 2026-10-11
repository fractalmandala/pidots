import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const READ_LIMIT = 1_000_000;
export const WRITE_LIMIT = 100_000;

export class FileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * The Dot's workspace. Paths are relative to it, or absolute inside a folder
 * the owner shared from their Mac (mounted at the same path). Each component
 * is checked so a symlink can never redirect a read or write outside them.
 */
export class Workspace {
  constructor(
    readonly root: string,
    /** Absolute paths of shared folders and files mounted in this computer. */
    readonly shared: string[] = [],
  ) {}

  /** The shared folder or file an absolute path is in, most specific first. */
  private sharedRoot(path: string) {
    const target = resolve(path);
    return this.shared
      .filter((root) => target === root || target.startsWith(root + sep))
      .sort((a, b) => b.length - a.length)[0];
  }

  /** Resolves a path and rejects traversal and symlinks. */
  private async resolve(path: string, { parents = false } = {}) {
    if (path.includes('\0') || path.split('/').some((part) => part === '..'))
      throw new FileError('Use a path without traversal.');
    const absolute = path.startsWith('/');
    const base = absolute ? this.sharedRoot(path) : this.root;
    if (!base)
      throw new FileError(
        'That path is not in the workspace or a shared folder.',
        403,
      );
    const root = await realpath(base);
    const target = absolute
      ? resolve(
          root,
          resolve(path).slice(resolve(base).length).replace(/^\//, ''),
        )
      : resolve(root, path);
    if (target !== root && !target.startsWith(root + sep))
      throw new FileError('Use a path without traversal.');
    const parts = target.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const last = index === parts.length - 1;
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new FileError(
            'Symbolic links are not followed in the workspace.',
          );
        if (!last && !info.isDirectory())
          throw new FileError(
            `${parts.slice(0, index + 1).join('/')} is not a folder.`,
          );
      } catch (error) {
        if (error instanceof FileError) throw error;
        if (!parents || last) {
          if (last) return { root, target, exists: false };
          throw new FileError(
            `No such folder: ${parts.slice(0, index + 1).join('/')}`,
            404,
          );
        }
        await mkdir(current, { mode: 0o755 });
      }
    }
    return { root, target, exists: true };
  }

  async list(path = '') {
    const { target, exists } = await this.resolve(path);
    if (!exists) throw new FileError(`No such folder: ${path || '.'}`, 404);
    const entries = await readdir(target, { withFileTypes: true });
    return {
      path,
      entries: await Promise.all(
        entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 1000)
          .map(async (entry) => {
            const info = await lstat(join(target, entry.name));
            return {
              name: entry.name,
              type: entry.isSymbolicLink()
                ? 'symlink'
                : entry.isDirectory()
                  ? 'directory'
                  : 'file',
              size: info.size,
              modifiedAt: info.mtimeMs,
            };
          }),
      ),
    };
  }

  async read(path: string) {
    const { target, exists } = await this.resolve(path);
    if (!exists) throw new FileError(`No such file: ${path}`, 404);
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new FileError(`${path} is not a file.`);
      const size = Math.min(info.size, READ_LIMIT);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return {
        path,
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        size: info.size,
        truncated: info.size > READ_LIMIT,
      };
    } finally {
      await handle.close();
    }
  }

  async write(path: string, contents: string, append = false) {
    const data = Buffer.from(contents, 'utf8');
    if (data.length > WRITE_LIMIT)
      throw new FileError(
        `Files can be written up to ${WRITE_LIMIT} bytes at a time.`,
      );
    const { target } = await this.resolve(path, { parents: true });
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        (append ? constants.O_APPEND : constants.O_TRUNC),
      0o644,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new FileError(`${path} is not a file.`);
      const before = append ? info.size : 0;
      let written = 0;
      while (written < data.length) {
        const { bytesWritten } = await handle.write(data, written);
        written += bytesWritten;
      }
      await handle.sync();
      const after = (await handle.stat()).size;
      if (after !== before + data.length)
        throw new FileError(
          'The file size after writing did not match; the write may be incomplete.',
          500,
        );
      return { path, bytes: data.length, size: after, appended: append };
    } finally {
      await handle.close();
    }
  }
}
