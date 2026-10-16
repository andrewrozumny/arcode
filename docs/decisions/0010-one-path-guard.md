# 0010. One path guard that follows symlinks

## Context

The renderer names files by project-relative path in the tree, the viewer and the import dialog.
The viewer used to check paths lexically only, while the tree also resolved symlinks, so a link
inside the project that pointed elsewhere could be read and written through the viewer.

## Decision

`main/files/paths.ts` is the only guard. `resolveInside` normalises the path, refuses absolute
paths and `..` escapes, then compares the real path of the target (or of its nearest existing
ancestor) with the real path of the root. `resolveEntryInside` checks only the parent, for rename
and delete of a symlink entry itself.

## Consequences

- Every module refuses the same paths with the same messages.
- A symlink inside the project that points outside it can be renamed or trashed, but not opened
  in the viewer.
- Each check costs a `realpath`; this is async and cheap next to the file operation itself.
