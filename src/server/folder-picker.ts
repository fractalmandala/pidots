import { execFile } from 'node:child_process';

/** AppleScript for the standard macOS open panel; argv: kind, prompt. */
const script = `on run argv
  activate
  if item 1 of argv is "file" then
    set picked to choose file with prompt (item 2 of argv) with multiple selections allowed
  else
    set picked to choose folder with prompt (item 2 of argv) with multiple selections allowed
  end if
  set out to ""
  repeat with chosen in picked
    set out to out & POSIX path of chosen & linefeed
  end repeat
  return out
end run`;

/**
 * Shows the macOS folder (or file) picker on the owner's Mac and returns the
 * chosen absolute paths, or none if they cancel. The server runs on the same
 * Mac as the app, so the panel appears there.
 */
export function pickPaths(
  kind: 'directory' | 'file',
  prompt: string,
): Promise<string[]> {
  if (process.platform !== 'darwin')
    return Promise.reject(
      new Error('Choosing folders is only available on macOS.'),
    );
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script, kind === 'file' ? 'file' : 'folder', prompt],
      { timeout: 10 * 60_000 },
      (error, stdout, stderr) => {
        // -128 is "User canceled."
        if (error && /-128/.test(stderr)) return resolve([]);
        if (error)
          return reject(new Error('The folder picker could not be shown.'));
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((path) => (path.length > 1 ? path.replace(/\/$/, '') : path)),
        );
      },
    );
  });
}
