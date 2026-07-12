#!/usr/bin/env bun
import { CommanderError } from "commander";
import { createCli } from "./cli.ts";
import { CliError, ReportedCliError } from "./errors.ts";

const cli = createCli();

try {
  await cli.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else if (error instanceof CliError) {
    if (!(error instanceof ReportedCliError)) console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 5;
  }
}
