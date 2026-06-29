# Workers Analytics Engine Queries

Sample queries for the `tila-analytics` dataset. Run these via the
[Cloudflare Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

## Dataset Schema

Both request and DO operation datapoints share the `tila-analytics` dataset.
Use `blob4` (type discriminator) to filter by event type.

### Request datapoints (`blob4 = 'request'`)

| Field | Column | Example |
|-------|--------|---------|
| Route pattern | `blob1` | `/projects/:projectId/entities` |
| HTTP method | `blob2` | `GET` |
| Project ID | `blob3` | `proj-abc` (or empty for unauthenticated) |
| Type | `blob4` | `request` |
| Latency (ms) | `double1` | `42` |
| Status code | `double2` | `200` |
| Index (partition) | `index1` | Project ID or `anonymous` |

### DO operation datapoints (`blob4 = 'do_operation'`)

| Field | Column | Example |
|-------|--------|---------|
| Table | `blob1` | `entities` |
| Operation type | `blob2` | `create` |
| Project ID | `blob3` | `proj-abc` |
| Type | `blob4` | `do_operation` |
| Latency (ms) | `double1` | `15` |
| Rows affected | `double2` | `1` |
| Index (partition) | `index1` | Project ID |

> **Note:** `double2` carries the rows affected by the operation. The DO response envelope exposes
> an `X-Rows-Affected` header for entity and record write operations, which the Worker forwards into
> `double2` (`packages/worker/src/lib/analytics.ts`). Operations that do not report a row count emit `0`.

## Sample Queries

### 1. Error rate by route (last 24 hours)

```sql
SELECT
  blob1 AS route,
  SUM(IF(double2 >= 400, 1, 0)) AS errors,
  COUNT() AS total,
  SUM(IF(double2 >= 400, 1, 0)) / COUNT() AS error_rate
FROM tila-analytics
WHERE
  blob4 = 'request'
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY route
ORDER BY error_rate DESC
```

### 2. Request latency p95 by route (last hour)

```sql
SELECT
  blob1 AS route,
  QUANTILEWEIGHTED(0.95)(double1, 1) AS p95_ms,
  QUANTILEWEIGHTED(0.50)(double1, 1) AS p50_ms,
  COUNT() AS requests
FROM tila-analytics
WHERE
  blob4 = 'request'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY route
ORDER BY p95_ms DESC
```

### 3. DO operation latency p95 by table and operation (last hour)

```sql
SELECT
  blob1 AS table_name,
  blob2 AS operation,
  QUANTILEWEIGHTED(0.95)(double1, 1) AS p95_ms,
  COUNT() AS ops
FROM tila-analytics
WHERE
  blob4 = 'do_operation'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY table_name, operation
ORDER BY p95_ms DESC
```

### 4. Claim acquisition throughput (per minute, last hour)

```sql
SELECT
  TOSTARTOFINTERVAL(timestamp, INTERVAL '1' MINUTE) AS minute,
  COUNT() AS claim_ops
FROM tila-analytics
WHERE
  blob4 = 'do_operation'
  AND blob2 = 'acquire'
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY minute
ORDER BY minute ASC
```

## Running Queries

Use the [Workers Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/):

```bash
curl "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql" \
  -H "Authorization: Bearer {token}" \
  -d "SELECT blob1 AS route, COUNT() AS requests FROM tila-analytics WHERE blob4 = 'request' GROUP BY route"
```

Replace `{account_id}` and `{token}` with your Cloudflare account ID and API token (requires
`analytics_engine:read` permission).
