export interface PullRequestAuditItem {
  repository_owner: string;
  merged: boolean;
}

export function countExternalMergedPrs(items: PullRequestAuditItem[], ownerLogin: string): number {
  const owner = ownerLogin.toLowerCase();
  let count = 0;

  for (const item of items) {
    if (item.merged && item.repository_owner.toLowerCase() !== owner) {
      count += 1;
    }
  }

  return count;
}
