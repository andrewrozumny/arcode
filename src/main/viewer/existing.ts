import { stat } from 'node:fs/promises';
import { resolveInside } from '../files/paths';

/**
 * Keeps the project-relative paths that are regular files inside `root`, in order. Used for
 * restored viewer tabs and recent files, so files deleted or moved since are skipped.
 */
export async function existingFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(await resolveInside(root, path))).isFile();
      } catch {
        return false;
      }
    }),
  );
  return paths.filter((_path, index) => checks[index]);
}
