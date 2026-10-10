// The web app (apps/web), served from S3 through CloudFront.

/** Each environment's web app bucket, in its home region. */
export const webBucket = (env: string, account: string, region: string) => `hearth-${env}-web-${account}-${region}`;
