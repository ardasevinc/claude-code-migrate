#!/usr/bin/env bun
import { CommanderError } from "commander";
import { createCli } from "./cli.ts";

const cli = createCli();

try {
  await cli.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
