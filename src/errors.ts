export type CcmExitCode = 1 | 2 | 3 | 4 | 5;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: CcmExitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export class ReportedCliError extends CliError {
  constructor(exitCode: CcmExitCode, options?: ErrorOptions) {
    super("", exitCode, options);
    this.name = "ReportedCliError";
  }
}

export class UsageError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, options);
    this.name = "UsageError";
  }
}

export class BlockedError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, options);
    this.name = "BlockedError";
  }
}

export class ConnectivityError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 4, options);
    this.name = "ConnectivityError";
  }
}

export class ExecutionError extends CliError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 5, options);
    this.name = "ExecutionError";
  }
}
