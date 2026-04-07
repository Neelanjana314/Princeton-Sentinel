type SitePrincipalCountsCteOptions = {
  cteName?: string;
  paramIndex: number;
  sourceName?: string;
  sourceAlias?: string;
};

export function buildSitePrincipalCountsCte({
  cteName = "principal_counts",
  paramIndex,
  sourceName = "mv_msgraph_site_principal_identities",
  sourceAlias = "spi",
}: SitePrincipalCountsCteOptions) {
  return `
  ${cteName} AS (
    SELECT
      ${sourceAlias}.site_key,
      COUNT(*) FILTER (WHERE ${sourceAlias}.is_guest)::int AS guest_users,
      COUNT(*) FILTER (
        WHERE NOT ${sourceAlias}.is_guest
          AND COALESCE(array_length($${paramIndex}::text[], 1), 0) > 0
          AND ${sourceAlias}.email_domain IS NOT NULL
          AND NOT (${sourceAlias}.email_domain LIKE ANY($${paramIndex}::text[]))
      )::int AS external_users
    FROM ${sourceName} ${sourceAlias}
    GROUP BY ${sourceAlias}.site_key
  )`;
}
