# 0008. Browse only the home folder, accept any file on paste and drop

## Context

Users bring screenshots, downloads and documents into a project. The Import from Mac dialog lets
the renderer list and preview folders outside the project, which is a file-system browser exposed
to web content. Paste (files copied in Finder) and drop (files dragged from Finder) come from an
explicit user action on concrete files that can live anywhere, for example on an external disk.

## Decision

Listing and previewing outside the project is limited to the home folder (`isInsideHome`).
Copying into the project accepts any absolute path to an existing regular file as a source, since
those paths come from the clipboard or a drop. The destination always goes through the project
path guard, and name clashes get ` (2)`, ` (3)` suffixes instead of overwriting.

## Consequences

- The renderer cannot enumerate arbitrary folders such as `/etc`, yet paste and drop work for
  files anywhere the user can reach in Finder.
- Only files are imported; folders are refused.
