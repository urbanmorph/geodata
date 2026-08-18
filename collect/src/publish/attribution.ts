// Compose the single credit line + the contributors.json breakdown at publish
// (spec → "Attribution", the OpenStreetMap model). The headline counts distinct
// *named* contributors and notes anonymous separately, because distinct
// anonymous people can't be counted; every anonymous record is tallied into one
// bucket in the breakdown.

export interface ContributorTally {
  name: string;
  records: number;
}

export interface ComposedAttribution {
  line: string;
  contributors: ContributorTally[];
}

export function composeAttribution(
  projectName: string,
  license: string,
  contributorNames: readonly (string | null | undefined)[],
): ComposedAttribution {
  const counts = new Map<string, number>();
  let anon = 0;
  for (const raw of contributorNames) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') anon += 1;
    else counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const named: ContributorTally[] = [...counts.entries()]
    .map(([name, records]) => ({ name, records }))
    .sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));

  const contributors: ContributorTally[] = [...named];
  if (anon > 0) contributors.push({ name: 'anonymous', records: anon });

  const n = named.length;
  let who = '';
  if (n === 0 && anon > 0) who = 'anonymous contributors';
  else if (n > 0) {
    who = `${n} contributor${n === 1 ? '' : 's'}`;
    if (anon > 0) who += ' + anonymous';
  }

  const line = who ? `${projectName} — ${who} (${license})` : projectName;
  return { line, contributors };
}
