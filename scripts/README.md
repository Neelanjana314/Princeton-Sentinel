# Scripts

## `db_migrations.py`

Run one SQL migration file from `db/migrations` against a target Postgres database.

### Usage

```bash
python3 scripts/db_migrations.py db/migrations/<migration_name>.sql
```

### Behavior

- Accepts exactly one SQL file path.
- Rejects files outside `db/migrations`.
- Prompts for `DATABASE_URL` interactively.
- Prompts for explicit confirmation (`yes`) before execution.
- Executes the SQL in a single transaction (commit on success, rollback on failure).

### Requirements

- Python 3.10+ (3.11 preferred)
- `psycopg2-binary` installed locally

Install dependency example:

```bash
python3 -m pip install psycopg2-binary
```

## `generate-license.mjs`

Generate a signed license artifact into `.local/licenses/` using a local private key that is not committed to VCS.

### Usage

```bash
node scripts/generate-license.mjs \
  --license-type enterprise \
  --tenant-id 00000000-0000-0000-0000-000000000000 \
  --expires-at 2026-12-31T23:59:59Z \
  --preset enterprise
```
