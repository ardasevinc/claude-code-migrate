#!/usr/bin/env bun
import { createCli } from "./cli.ts";

const cli = createCli();
cli.parse(process.argv);
