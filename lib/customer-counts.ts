/**
 * Count each active customer once per warehouse, including shared memberships.
 * DISTINCT preserves the old EXISTS semantics for duplicate JSON memberships;
 * TEXT matches users.warehouse_id affinity, including mixed numeric/text aliases.
 * an empty warehouseIds array stays empty instead of falling back to warehouse_id.
 * Columns and trailing user filters are static SQL supplied only by server code.
 */
export function selectUsersWithClientCounts(columns = 'u.*') {
  return `WITH customer_memberships AS (
    SELECT DISTINCT c.id customer_id,CAST(w.value AS TEXT) warehouse_id
    FROM customers c
    JOIN json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w
    WHERE c.active=1
  ), warehouse_customer_counts AS (
    SELECT warehouse_id,COUNT(*) client_count FROM customer_memberships GROUP BY warehouse_id
  ) SELECT ${columns},COALESCE(counts.client_count,0) client_count
    FROM users u LEFT JOIN warehouse_customer_counts counts ON counts.warehouse_id=u.warehouse_id`;
}
