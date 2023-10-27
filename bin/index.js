#!/usr/bin/env node

import { input } from "@inquirer/prompts";
import "dotenv/config";
import postgres from "postgres";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  applyMigrations,
  generateMigration,
  resetDatabase,
} from "../lib/index.js";

yargs(hideBin(process.argv))
  .command(
    "generate [name]",
    "Generate a new migration file",
    (yargs) => {
      return yargs.option("dir", {
        alias: "d",
        describe: "Path to where the migrations are stored",
        default: "./migrations",
        string: true,
      });
    },
    async (argv) => {
      let name = argv.name;
      if (typeof name !== "string") {
        name = await input({
          message: "Name of the migration",
        });
      }
      await generateMigration(name, argv.dir);
    }
  )
  .command(
    "apply",
    "Apply all pending migrations",
    (yargs) => {
      return yargs.option("dir", {
        alias: "d",
        describe: "Path to where the migrations are stored",
        default: "./migrations",
        string: true,
      });
    },
    async (argv) => {
      const sql = postgres(process.env.DATABASE_URL, {
        onnotice: () => {},
      });
      const result = await applyMigrations(sql, argv.dir);
      await sql.end();
      if (!result) process.exit(1);
    }
  )
  .command(
    "reset",
    "Reset the database",
    (yargs) => {
      return yargs
        .option("force", {
          alias: "f",
          describe: "Force the reset without prompting",
          default: false,
          boolean: true,
        })
        .option("dir", {
          alias: "d",
          describe: "Path to where the migrations are stored",
          default: "./migrations",
          string: true,
        });
    },
    async (argv) => {
      const sql = postgres(process.env.DATABASE_URL, {
        onnotice: () => {},
      });
      await resetDatabase(sql, argv.dir, argv.force);
      await sql.end();
    }
  )
  .demandCommand(1, "You need at least one command before moving on")
  .scriptName('spm')
  .usage('PostgreSQL forward-only migration tool.\n\nUsage: $0 <cmd> [options]')
  .parse();
