import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirEntry, GitStatusMap } from '@shared/files';
import { readExpanded, writeExpanded } from './expandedStorage';
import { getFilesApi, parentOf } from './model';

const EMPTY_GIT: GitStatusMap = { files: {}, dirs: [] };

/**
 * Loaded folder listings, expanded folders and git status of one project tree. Lists the root and
 * the remembered folders on mount, watches the project and reloads changed folders.
 */
export function useDirectoryTree(projectRoot: string) {
  const api = getFilesApi();
  const [children, setChildren] = useState(() => new Map<string, DirEntry[]>());
  const childrenRef = useRef(children);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readExpanded(projectRoot)));
  const [git, setGit] = useState<GitStatusMap>(EMPTY_GIT);
  const expandedRef = useRef(expanded);
  const alive = useRef(true);

  useEffect(() => {
    childrenRef.current = children;
    expandedRef.current = expanded;
  }, [children, expanded]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadDir = useCallback(
    async (rel: string): Promise<boolean> => {
      try {
        const entries = await api.listDir(projectRoot, rel);
        if (!alive.current) return false;
        setChildren((prev) => new Map(prev).set(rel, entries));
        return true;
      } catch {
        if (!alive.current) return false;
        setChildren((prev) => {
          if (!prev.has(rel)) return prev;
          const next = new Map(prev);
          next.delete(rel);
          return next;
        });
        setExpanded((prev) => {
          if (!prev.has(rel)) return prev;
          const next = new Set(prev);
          next.delete(rel);
          return next;
        });
        return false;
      }
    },
    [api, projectRoot],
  );

  // Project (re)load: root listing, remembered folders, watcher, git status.
  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadDir('');
      for (const rel of readExpanded(projectRoot)) void loadDir(rel);
    });
    void api.gitStatus(projectRoot).then((map) => setGit(map), () => undefined);
    void api.watch(projectRoot).catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const dirty = new Set<string>();
    const offChanged = api.onChanged((event) => {
      if (event.root !== projectRoot) return;
      for (const path of event.paths) {
        const parent = parentOf(path);
        if (childrenRef.current.has(parent)) dirty.add(parent);
        // A directory itself may have been removed or added.
        if (childrenRef.current.has(path)) dirty.add(path);
      }
      if (dirty.size === 0 || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = [...dirty];
        dirty.clear();
        for (const rel of batch) void loadDir(rel);
      }, 120);
    });
    const offGit = api.onGitStatus((event) => {
      if (event.root === projectRoot) setGit(event.map);
    });
    return () => {
      offChanged();
      offGit();
      if (timer) clearTimeout(timer);
      void api.unwatch(projectRoot).catch(() => undefined);
    };
  }, [api, projectRoot, loadDir]);

  useEffect(() => {
    writeExpanded(projectRoot, expanded);
  }, [projectRoot, expanded]);

  const expandDir = useCallback(
    async (rel: string): Promise<void> => {
      setExpanded((prev) => (prev.has(rel) ? prev : new Set(prev).add(rel)));
      if (!childrenRef.current.has(rel)) await loadDir(rel);
    },
    [loadDir],
  );

  const collapseDir = useCallback((rel: string): void => {
    setExpanded((prev) => {
      if (!prev.has(rel)) return prev;
      const next = new Set(prev);
      next.delete(rel);
      return next;
    });
  }, []);

  const toggleDir = useCallback(
    (rel: string): void => {
      if (expandedRef.current.has(rel)) collapseDir(rel);
      else void expandDir(rel);
    },
    [collapseDir, expandDir],
  );

  return { children, setChildren, childrenRef, expanded, setExpanded, git, loadDir, expandDir, collapseDir, toggleDir };
}
