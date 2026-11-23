import { type FSWatcher, mkdirSync, statSync, watch } from "node:fs";

export interface WatchDeps {
  watch: typeof watch;
  log: (line: string) => void;
}

export interface RefWatcher {
  close(): void;
}

/**
 * Calls `onEvent` for every change in `directory`, the parent of a loose branch ref.
 * Git writes a ref through a `.lock` file renamed into place, so every new commit
 * produces an event there. `fs.watch` may give no file name, so the caller re-reads
 * the ref on each event instead of trusting it.
 *
 * On Linux `fs.watch` follows the directory's inode: when Git removes and recreates
 * the directory (for example after packing refs), the old watch goes quiet. Each event
 * therefore checks the inode, and a changed inode or a watcher error re-arms the
 * watch (recreating the directory, as Git would).
 */
export function watchRefDirectory(
  directory: string,
  onEvent: () => void,
  deps: WatchDeps,
): RefWatcher {
  let watcher: FSWatcher | undefined;
  let inode: number | undefined;
  let closed = false;
  const arm = (): void => {
    watcher?.close();
    watcher = undefined;
    if (closed) {
      return;
    }
    try {
      mkdirSync(directory, { recursive: true });
      inode = statSync(directory).ino;
      const current = deps.watch(directory, () => {
        onEvent();
        if (statSync(directory, { throwIfNoEntry: false })?.ino !== inode) {
          arm();
        }
      });
      current.on("error", (error) => {
        deps.log(`The ref watcher failed (${String(error)}); watching again`);
        arm();
        onEvent();
      });
      watcher = current;
    } catch (error) {
      deps.log(
        `Cannot watch ${directory} (${String(error)}); ` +
          "progress is saved by the final push",
      );
    }
  };
  arm();
  return {
    close: () => {
      closed = true;
      watcher?.close();
    },
  };
}
