import type { CoverChoice } from '@/types/shared';
/** Metadata/thumbnail refreshes do not change a validated cover's identity. */
export function coverContext(id: string, identity: string, choice: CoverChoice) {
  // Auto still resolves catalog → sources → owned-library artwork.
  // Once validated, its source URL and bytes stay pinned until the work or choice changes.
  return JSON.stringify([id, identity, choice]);
}
