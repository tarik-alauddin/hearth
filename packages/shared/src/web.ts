// The web app (apps/web), served from S3 through CloudFront.

/** Each environment's web app bucket, in its home region. */
export const webBucket = (env: string, account: string, region: string) => `hearth-${env}-web-${account}-${region}`;

/** What the web app reads at start-up (`/config.json`, written by WebContentStack): where the API
 *  and sign-in are. */
export interface WebConfig {
  env: string;
  apiUrl: string;
  auth: {
    region: string;
    /** The managed login pages: https://hearth-<env>-<account>.auth.<region>.amazoncognito.com */
    domain: string;
    /** The web app's Cognito client (public: PKCE). */
    clientId: string;
  };
}
