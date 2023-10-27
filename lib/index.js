import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import crypto from "node:crypto";
import { confirm } from "@inquirer/prompts";

/**
 * Generates a new migration file.
 * @param {string} name Name of the migration
 * @param {string} baseDir Path to where the migrations are stored
 */
export async function generateMigration(name, baseDir) {
  // Ensure absolute path
  const targetDir = path.resolve(baseDir);

  // 2023-10-25T19:42:00.000Z -> 20231025194200
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

  // Ensure file name is lowercase and snake_case
  const fileName = `${timestamp}_${name
    .toLowerCase()
    .replace(/[^ a-z\d]/g, "")
    .replace(/\s/g, "_")}.sql`;

  // Ensure directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // Create file
  await fs.writeFile(
    path.join(targetDir, fileName),
    "-- Write your migration here\n"
  );

  console.log(chalk.bold.green("Created"), path.join(baseDir, fileName));
}

/**
 * Applies all pending migrations.
 * @param {import('postgres').Sql} sql
 * @param {string} baseDir Path to where the migrations are stored
 */
export async function applyMigrations(sql, baseDir) {
  try {
    // Read all migration file paths and their checksums
    const migrationFiles = await getMigrationFiles(baseDir);
    const migrationFilesLookup = Object.fromEntries(
      migrationFiles.map((migration) => [migration.name, migration])
    );

    const appliedCount = await sql.begin(
      "ISOLATION LEVEL SERIALIZABLE",
      async (txn) => {
        await ensureMigrationsTableExists(txn);
        await lockMigrationsTable(txn);

        // Fetch applied migrations and compute pending migrations
        const migrations = await getMigrations(txn);
        const migrationsLookup = Object.fromEntries(
          migrations.map((migration) => [migration.name, migration])
        );
        const pendingMigrations = migrationFiles.filter(
          (migration) => !migrationsLookup[migration.name]
        );

        // Get the last migration that was applied to determine the round
        const lastMigration = migrations.at(-1);
        const lastMigrationRound = lastMigration?.round ?? 0;
        const round = lastMigrationRound + 1;

        // Check that all applied migration checksums match
        for (const migration of migrations) {
          const migrationFile = migrationFilesLookup[migration.name];
          if (migration.checksum !== migrationFile.checksum) {
            throw new Error(
              `Checksum mismatch for migration "${migration.name}"`
            );
          }
        }

        // Apply all pending migrations
        for (const migration of pendingMigrations) {
          await applyMigration(txn, migration, round);
        }

        return pendingMigrations.length;
      }
    );

    console.log(chalk.bold.green("Applied"), `${appliedCount} migrations`);
    return true;
  } catch (error) {
    console.error(chalk.bold.red("Failed"), error.message);
    return false;
  }
}

/**
 * Resets the database by dropping all tables and re-applying all migrations.
 * @param {import('postgres').Sql} sql
 * @param {string} baseDir Path to where the migrations are stored
 * @param {boolean} force Whether to force the reset without prompting
 */
export async function resetDatabase(sql, baseDir, force) {
  if (!force) {
    const answer = await confirm({
      message:
        "Are you sure you want to reset the database? This will drop all tables and re-apply all migrations.",
    });

    if (!answer) {
      console.log(chalk.bold.yellow("Aborted"));
      return false;
    }
  }

  try {
    await sql.begin(async (txn) => {
      /** @type {Array<{ search_path: string }>} */
      const searchPathResult = await txn`SHOW search_path`;

      /** @type {Array<{ user: string }>} */
      const userResult = await txn`SELECT user`;

      const username = userResult[0].user;

      const schemas = searchPathResult[0].search_path
        .split(",")
        .map((s) => {
          const trimmed = s.trim();
          if (trimmed === '"$user"') {
            return username;
          }
          return trimmed;
        });

      // Drop all tables
      const tables = await txn`
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname IN ${txn(schemas)}
      `;

      for (const table of tables) {
        await txn`DROP TABLE IF EXISTS ${txn(table.schemaname)}.${txn(table.tablename)} CASCADE`;
      }
    });

    console.log(chalk.bold.green("Reset"), "Tables dropped");

    // Apply all migrations
    return await applyMigrations(sql, baseDir);
  } catch (error) {
    console.error(chalk.bold.red("Failed"), error.message);
    return false;
  }
}

/**
 * Creates the migrations table, if it does not already exist.
 * @param {import('postgres').Sql} sql
 */
async function ensureMigrationsTableExists(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS __migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum TEXT NOT NULL,
      round INT NOT NULL
    )
  `;
}

/**
 * Gets the currently applied migrations.
 * @param {import('postgres').Sql} sql
 * @returns {Promise<Migration[]>}
 */
async function getMigrations(sql) {
  return sql`
    SELECT * FROM __migrations
    ORDER BY round ASC, name ASC
  `;
}

/**
 * Locks the table for the duration of the transaction.
 * @param {import('postgres').Sql} sql
 */
async function lockMigrationsTable(sql) {
  await sql`LOCK TABLE __migrations IN EXCLUSIVE MODE`;
}

/**
 * Gets a list of paths to all migrations.
 * @param {string} baseDir Path to where the migrations are stored
 * @returns {Promise<MigrationFile[]>}
 */
async function getMigrationFiles(baseDir) {
  const files = await fs.readdir(baseDir);
  const result = [];

  for (const file of files) {
    if (file.endsWith(".sql")) {
      const filePath = path.join(baseDir, file);
      result.push({
        name: file,
        path: filePath,
        checksum: await computeChecksum(filePath),
      });
    }
  }

  return result;
}

/**
 * Applies a single migration
 * @param {import('postgres').Sql} sql
 * @param {MigrationFile} migration
 * @param {number} round
 */
async function applyMigration(sql, migration, round) {
  await sql.file(migration.path);
  await sql`
    INSERT INTO __migrations (name, checksum, round)
    VALUES (${migration.name}, ${migration.checksum}, ${round})
  `;
}

/**
 * Computes a SHA256 checksum for a file.
 * @param {string} path Path to file to calculate checksum for
 * @returns {Promise<string>}
 */
async function computeChecksum(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = createReadStream(path);

    rs.on("error", reject);

    rs.on("data", (chunk) => {
      hash.update(chunk);
    });

    rs.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

/**
 * @typedef {object} Migration
 * @property {string} name
 * @property {string} checksum
 * @property {number} round
 * @property {Date} applied_at
 */

/**
 * @typedef {object} MigrationFile
 * @property {string} name
 * @property {string} path
 * @property {string} checksum
 */
