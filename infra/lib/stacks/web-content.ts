import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Duration, Validations } from 'aws-cdk-lib';
import type { IDistribution } from 'aws-cdk-lib/aws-cloudfront';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import { webBucket, type WebConfig } from '@hearth/shared';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface WebContentStackProps extends HearthStackProps {
  /** The built web app (`apps/web/dist`): `pnpm --filter @hearth/web build` makes it. */
  readonly siteDir: string;
  /** FrontendStack's distribution (its bucket is found by its fixed name). */
  readonly distribution: IDistribution;
  /** What `config.json` says. */
  readonly webConfig: WebConfig;
}

/**
 * The web app's files, into FrontendStack's bucket, plus `config.json`. Last of an environment's
 * stacks: the config names the API and the sign-in client, built before it.
 */
export class WebContentStack extends HearthStack {
  constructor(scope: Construct, props: WebContentStackProps) {
    super(scope, 'WebContent', props);
    if (!existsSync(join(props.siteDir, 'index.html'))) {
      throw new Error(`No web app build in ${props.siteDir}: run \`pnpm --filter @hearth/web build\` first`);
    }
    // By its fixed name: a plain ARN in the copy helper's grant, rather than a cross-stack token.
    const siteBucket = webBucket(props.config.env, this.account, this.region);
    const bucket = Bucket.fromBucketName(this, 'Site', siteBucket);

    // Two copies, one per cache rule. Vite's assets/ (named by content hash) are cached for a year
    // and never pruned, so a page loaded before a deploy can still fetch its own files.
    const assets = new BucketDeployment(this, 'Assets', {
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
      sources: [Source.asset(props.siteDir, { exclude: ['assets', 'assets/**'] }), Source.jsonData('config.json', props.webConfig)],
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: props.distribution,
      distributionPaths: ['/*'], // one invalidation path (free); assets/ files never change under a name
      memoryLimit: 512,
    });
    entry.node.addDependency(assets); // assets first: the new index.html refers to them

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
        [`AwsSolutions-IAM5[Resource::arn:aws:s3:::${siteBucket}/*]`, `${why} every file in the site bucket.`],
        [`AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${props.config.qualifier}-assets-${this.account}-${this.region}/*]`, `${why} reads this environment's CDK asset bucket.`],
        ['AwsSolutions-IAM5[Resource::*]', `${why} CloudFront invalidations can't be scoped to one distribution.`],
      ]) {
        Validations.of(helper).acknowledge({ id: id!, reason: reason! });
      }
    }
  }
}
