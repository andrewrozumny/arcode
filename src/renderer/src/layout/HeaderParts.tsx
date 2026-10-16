import type { GitBranch } from '@shared/files';
import type { IdeStatus } from '@shared/ide-ipc';
import { avatarColor, initials } from './avatar';

export function ProjectAvatar({ name }: { name: string }) {
  return (
    <span className="project-avatar" style={{ background: avatarColor(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="5.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5.3v5.4M12 7.3c0 2.2-1.6 3-4 3.4-1.8.3-3 .8-4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function BranchLabel({ branch }: { branch: GitBranch }) {
  const title = branch.detached ? `Detached HEAD at ${branch.name}` : `Branch ${branch.name}`;
  return (
    <span className="header-branch" title={title}>
      <BranchIcon />
      {branch.name}
    </span>
  );
}

export function IdeIndicator({ status }: { status: IdeStatus }) {
  const { port, clients } = status;
  const title = port
    ? `Claude Code IDE bridge on port ${port}: ${clients} connected client${clients === 1 ? '' : 's'}`
    : 'Claude Code IDE bridge is not running';
  return (
    <span className={clients > 0 ? 'ide-indicator connected' : 'ide-indicator'} title={title}>
      <span className="ide-dot" aria-hidden="true" />
      IDE: {port ? `${clients} client${clients === 1 ? '' : 's'}` : 'off'}
    </span>
  );
}
