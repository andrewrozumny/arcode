import type { AcodeApi } from '@shared/ipc';
import type { AcodeAppApi } from '@shared/app';

declare global {
  interface Window {
    acode: AcodeApi & AcodeAppApi;
  }
}

export {};
