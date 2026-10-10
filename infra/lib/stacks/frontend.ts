import { CfnOutput, Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { webBucket } from '@hearth/shared';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/**
 * Where the web app is served: a private bucket and CloudFront on its own domain. Nothing here
 * depends on another stack, so it comes first: sign-in (AuthStack) needs the site's address for
 * its callback, and the API needs it for CORS. The files go in from WebContentStack, last.
 */
export class FrontendStack extends HearthStack {
  readonly bucket: Bucket;
  readonly distribution: Distribution;
  /** https://<distribution>.cloudfront.net */
  readonly siteUrl: string;

  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Frontend', props);
    const { env, isProd } = props.config;

    // Only CloudFront reads it (origin access control); every file is replaced on each deploy.
    this.bucket = new Bucket(this, 'Site', {
      bucketName: webBucket(env, this.account, this.region),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    Validations.of(this.bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Public static files, rebuilt on every deploy; CloudFront is the only reader.',
    });

    // The app loads nothing from other hosts (fonts are self-hosted), so the content policy can be
    // strict: its own files, plus the API it calls and the sign-in pages' token endpoint. Those two
    // are named by pattern, so this stack needn't wait for theirs (their stacks need this one).
    // Images may also come from Google's and Discord's avatar hosts (a signed-in user's picture).
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: https://*.googleusercontent.com https://cdn.discordapp.com",
      "font-src 'self'",
      `connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://*.auth.${this.region}.amazoncognito.com`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    const headers = new ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: `hearth-${env}-web-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });

    this.distribution = new Distribution(this, 'Cdn', {
      comment: `Hearth ${env} web app`,
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // Honours each file's Cache-Control: hashed assets for a year, index.html and config.json never.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // The app routes in the browser (/auth/callback, /app, /join/{code}…): any unknown path gets
      // index.html. A missing key is a 403 from S3 (CloudFront can't list the bucket), so both map.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    for (const [id, reason] of [
      ['AwsSolutions-CFR1', 'A public site for the whole group; no reason to block countries.'],
      ['AwsSolutions-CFR2', 'Static files only; the API has its own throttling. WAF later, with a domain, if needed.'],
      ['AwsSolutions-CFR3', 'Access logs would need a logging bucket; a static site at this scale does not need them.'],
      ['AwsSolutions-CFR4', "CloudFront's default certificate (no domain yet) can't set a TLS minimum; it allows TLSv1."],
      ['AwsSolutions-CFR7', 'Origin access control is used (S3BucketOrigin.withOriginAccessControl).'],
    ]) {
      Validations.of(this.distribution).acknowledge({ id: id!, reason: reason! });
    }
    this.siteUrl = `https://${this.distribution.distributionDomainName}`;

    new StringParameter(this, 'WebUrl', {
      parameterName: `/hearth/${env}/web-url`,
      stringValue: this.siteUrl,
      description: `Hearth ${env} web app address`,
    });
    new CfnOutput(this, 'Url', { value: this.siteUrl, description: 'The web app' });
  }
}
