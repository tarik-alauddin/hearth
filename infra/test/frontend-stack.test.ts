import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';
import { testApp } from './test-app.js';

const app = testApp();
addEnvironment(app, envConfig('dev'));
addChecks(app);
const assembly = app.synth();
const template = Template.fromJSON(assembly.getStackByName('hearth-dev-Frontend').template as Record<string, unknown>);

describe('FrontendStack', () => {
  it('keeps the site bucket private and HTTPS-only', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'hearth-dev-web-138300868928-us-west-2',
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3', SigningBehavior: 'always' }),
    });
  });

  it('serves HTTPS, index.html at the root and for every route the app handles itself', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 },
        ],
      }),
    });
  });

  it('sends a strict content policy: its own files, plus the API', () => {
    const [policy] = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as {
      Properties: { ResponseHeadersPolicyConfig: { SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: unknown } } } };
    }[];
    const csp = JSON.stringify(policy?.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src');
    expect(csp).toMatch(/ApiStack|hearth-dev-Api|Fn::ImportValue/); // the API's endpoint, from ApiStack
    expect(csp).not.toContain('unsafe');
  });

  it('copies hashed assets for a year and everything else uncached, then invalidates', () => {
    const deployments = Object.values(template.findResources('Custom::CDKBucketDeployment')) as {
      Properties: { Prune: boolean; SystemMetadata?: Record<string, string>; DistributionPaths?: string[] };
    }[];
    expect(deployments).toHaveLength(2);
    expect(deployments.every((d) => d.Properties.Prune === false)).toBe(true);
    const caching = deployments.map((d) => d.Properties.SystemMetadata?.['cache-control']).sort();
    expect(caching).toEqual(['no-cache', 'public, max-age=31536000, immutable']);
    const entry = deployments.find((d) => d.Properties.SystemMetadata?.['cache-control'] === 'no-cache');
    expect(entry?.Properties.DistributionPaths).toEqual(['/*']);
  });

  it('publishes the address in SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/hearth/dev/web-url', Type: 'String' });
  });

  it('refuses to synthesize without a web app build', () => {
    const bare = testApp();
    bare.node.setContext('webDist', '/no/such/build');
    expect(() => addEnvironment(bare, envConfig('dev'))).toThrow(/pnpm --filter @hearth\/web build/);
  });
});
