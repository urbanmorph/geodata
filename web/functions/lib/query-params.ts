// Parses /api/v1/layers/{id}/query search params. Pure, so the param contract
// (which names are options vs. column filters) is unit-tested.
//
// Any param that is not a reserved option name is treated as a `column=value`
// where-filter, so every new option MUST be added to RESERVED or it silently
// turns into a filter on a non-existent column.

export interface ParsedQueryParams {
  select?: string[];
  groupBy?: string;
  sum?: string[];
  limit: number;
  where?: Record<string, string>;
  includeCentroid: boolean;
}

const RESERVED = new Set(['select', 'group_by', 'sum', 'limit', 'where', 'order_by', 'include_centroid']);

function list(v: string | null): string[] | undefined {
  const items = v?.split(',').map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

export function parseQueryParams(sp: URLSearchParams): ParsedQueryParams {
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '100', 10), 1), 1000);

  // where: ?where=col1=val1,col2=val2 and/or direct ?col=val params
  const where: Record<string, string> = {};
  const whereParam = sp.get('where');
  if (whereParam) {
    for (const pair of whereParam.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) where[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  for (const [k, v] of sp.entries()) {
    if (!RESERVED.has(k) && v) where[k] = v;
  }

  return {
    select: list(sp.get('select')),
    groupBy: sp.get('group_by') || undefined,
    sum: list(sp.get('sum')),
    limit,
    where: Object.keys(where).length ? where : undefined,
    includeCentroid: sp.get('include_centroid') !== 'false',
  };
}
