// EC2 instance profile sessions look like
// arn:aws:sts::123456789012:assumed-role/<role name>/i-0123456789abcdef0
// EC2 sets the session name to the instance ID, and the instance role only trusts EC2, so the
// instance ID can't be forged, as long as the role is one of our game instance roles.
const ASSUMED_ROLE_ARN = /^arn:aws[a-z-]*:sts::\d{12}:assumed-role\/([^/]+)\/(i-[0-9a-f]{8,17})$/;

/** The calling instance's ID, or undefined if the caller isn't a game instance. */
export function callerInstanceId(userArn: string | undefined, instanceRoleNames: readonly string[]): string | undefined {
  const match = userArn ? ASSUMED_ROLE_ARN.exec(userArn) : null;
  if (!match) return undefined;
  const [, roleName, instanceId] = match;
  return roleName && instanceRoleNames.includes(roleName) ? instanceId : undefined;
}
