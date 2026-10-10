import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { webBucket } from '@hearth/shared';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface FrontendStackProps extends HearthStackProps {
  /** The built web app (`apps/web/dist`): `pnpm --filter @hearth/web build` makes it. */
  readonly siteDir: string;
  /** The API's endpoint: the app calls it, and the content policy allows it. */
  readonly apiUrl: string;
}

/** The web app: static files in a private bucket, served by CloudFront on its own domain. */
export class FrontendStack extends HearthStack {
  readonly distribution: Distribution;
  readonly siteUrl: string;

  constructor(scope: Construct, props: FrontendStackProps) {
    super(scope, 'Frontend', props);
    const { env, isProd } = props.config;
    if (!existsSync(join(props.siteDir, 'index.html'))) {
      throw new Error(`No web app build in ${props.siteDir}: run \`pnpm --filter @hearth/web build\` first`);
    }

    // Only CloudFront reads it (origin access control); every file is replaced on each deploy.
    const bucket = new Bucket(this, 'Site', {
      bucketName: webBucket(env, this.account, this.region),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    Validations.of(bucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Public static files, rebuilt on every deploy; CloudFront is the only reader.',
    });

    // The app loads nothing from other hosts (fonts are self-hosted), so the content policy can be
    // strict: its own files, plus the API it calls.
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${props.apiUrl}`,
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
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // Honours each file's Cache-Control: hashed assets for a year, index.html and config.json never.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // The app routes in the browser (/join/{code} and so on): any unknown path gets index.html.
      // A missing key is a 403 from S3 (CloudFront can't list the bucket), so both map.
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

    // Two copies, one per cache rule. Vite's assets/ (named by content hash) are cached for a year
    // and never pruned, so a page loaded before a deploy can still fetch its own files.
    new BucketDeployment(this, 'Assets', {
      destinationBucket: bucket,
      sources: [Source.asset(props.siteDir, { exclude: ['*', '!assets', '!assets/**'] })],
      cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(Duration.days(365)), CacheControl.immutable()],
      prune: false,
      memoryLimit: 512,
    });
    // Everything else (index.html, the favicon, files from public/) and the runtime config: never
    // cached, then CloudFront drops its copies.
    const entry = new BucketDeployment(this, 'Entry', {
      destinationBucket: bucket,
      sources: [
        Source.asset(props.siteDir, { exclude: ['assets', 'assets/**'] }),
        Source.jsonData('config.json', { env, apiUrl: props.apiUrl }),
      ],
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/*'], // one invalidation path (free); assets/ files never change under a name
      memoryLimit: 512,
    });
    entry.node.addDependency(this.node.findChild('Assets')); // assets first: the new index.html refers to them

    // Both copies run in CDK's one BucketDeployment helper Lambda, at deploy time only.
    const helper = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'));
    if (helper) {
      const why = "CDK's BucketDeployment helper, run only during a deploy:";
      for (const [id, reason] of [
        ['AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', `${why} the AWS-maintained policy only allows writing its logs.`],
        ['AwsSolutions-L1', `${why} CDK sets its runtime.`],
        ['AwsSolutions-IAM5[Action::s3:GetBucket*]', `${why} CDK's grant to copy the build from its asset bucket to the site bucket.`],
        ['AwsSolutions-IAM5[Action::s3:GetObject*]', `${why} CDK's grant to copy the build from its asset bucket to the site bucket.`],
        ['AwsSolutions-IAM5[Action::s3:List*]', `${why} CDK's grant to copy the build from its asset bucket to the site bucket.`],
        ['AwsSolutions-IAM5[Action::s3:Abort*]', `${why} CDK's grant to write the site bucket.`],
        ['AwsSolutions-IAM5[Action::s3:DeleteObject*]', `${why} CDK's grant to write the site bucket (nothing is pruned: prune is off).`],
        ['AwsSolutions-IAM5[Resource::<SiteE53D7754.Arn>/*]', `${why} every file in the site bucket.`],
        [`AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${props.config.qualifier}-assets-${this.account}-${this.region}/*]`, `${why} reads this environment's CDK asset bucket.`],
        ['AwsSolutions-IAM5[Resource::*]', `${why} CloudFront invalidations can't be scoped to one distribution.`],
      ]) {
        Validations.of(helper).acknowledge({ id: id!, reason: reason! });
      }
    }

    new StringParameter(this, 'WebUrl', {
      parameterName: `/hearth/${env}/web-url`,
      stringValue: this.siteUrl,
      description: `Hearth ${env} web app address`,
    });
    new CfnOutput(this, 'Url', { value: this.siteUrl, description: 'The web app' });
  }
}
