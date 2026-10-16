/** Reads BUNKO_<name>, falling back to the former KAVISEERR_<name> so existing deployments keep working. */
export function env(name: string): string | undefined {
  return process.env[`BUNKO_${name}`] ?? process.env[`KAVISEERR_${name}`];
}
