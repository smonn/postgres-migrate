# @smonn/postgres-migrate

PostgreSQL forward-only migration tool using [Postgres.js](https://www.npmjs.com/package/postgres).

```sh
# 1. install
pnpm install @smonn/postgres-migrate

# 2. generate migration file
spm generate 'my migration'

# 3. edit the migration file as needed

# 4. apply pending migrations
spm apply

# 5. reset the database
spm reset
```

## Configuration

Assumes the environment variable `DATABASE_URL` is set, either in the current shell or in a `.env` file (relies on [`dotenv`](https://www.npmjs.com/package/dotenv)).

You can also customize the migrations directory using the `--dir` / `-d` flag with any of the commands. It defaults to the current working directory + `migrations`.

## Commands

### `spm generate [--dir=./migrations] [name]`

Generates a new migration file. If name is not provided, you will be prompted for one. The name will be transformed into snake_case and made lowercase. All non-alphanumeric characters will be stripped.

### `spm apply [--dir=./migrations]`

Applies all pending migrations in a single transaction. Will fail if a previously applied migration was changed, causing the checksum to mismatch.

### `spm reset [--dir=./migrations] [--force]`

Drops all tables and re-applies all migrations. Use `--force` / `-f` to skip the confirmation prompt.
