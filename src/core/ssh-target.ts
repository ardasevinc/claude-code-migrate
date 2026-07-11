export interface SshTarget {
  raw: string;
  host: string;
  user?: string;
}

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidIpv4(host: string): boolean {
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number.parseInt(octet, 10) <= 255,
    )
  );
}

function isValidHost(host: string): boolean {
  if (!COMPONENT_PATTERN.test(host)) {
    return false;
  }

  if (/^[0-9.]+$/.test(host)) {
    return isValidIpv4(host);
  }

  return true;
}

/** Parse a destination safe to pass as a single SSH destination argument. */
export function parseSshTarget(raw: string): SshTarget {
  const parts = raw.split("@");
  if (parts.length > 2) {
    throw new Error(`Invalid SSH target '${raw}'`);
  }

  const host = parts.at(-1) ?? "";
  const user = parts.length === 2 ? parts[0] : undefined;

  if (!isValidHost(host) || (user !== undefined && !COMPONENT_PATTERN.test(user))) {
    throw new Error(`Invalid SSH target '${raw}'`);
  }

  return user === undefined ? { raw, host } : { raw, user, host };
}

export function isValidSshTarget(raw: string): boolean {
  try {
    parseSshTarget(raw);
    return true;
  } catch {
    return false;
  }
}
