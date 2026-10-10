import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';
import { testApp } from './test-app.js';

const app = testApp();
addEnvironment(app, envConfig('dev'));
addChecks(app);
const assembly = app.synth();
const stack = (name: string) => assembly.getStackByName(`hearth-dev-${name}`);
const frontend = Template.fromJSON(stack('Frontend').template as Record<string, unknown>);
const content = Template.fromJSON(stack('WebContent').template as Record<string, unknown>);
const api = Template.fromJSON(stack('Api').template as Record<string, unknown>);

describe('FrontendStack', () => {
  it('depends on no other stack, so sign-in and the API can name its address', () => {
    // Its only dependency is its own asset bundle, not another stack.
    expect(stack('Frontend').dependencies.map((d) => d.id).filter((id) => !id.endsWith('.assets'))).toEqual([]);
    const auth = stack('Auth').dependencies.map((d) => d.id);
    expect(auth).toContain('hearth-dev-Frontend');
  });

  it('keeps the site bucket private and HTTPS-only', () => {
    frontend.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'hearth-dev-web-138300868928-us-west-2',
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    frontend.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3', SigningBehavior: 'always' }),
    });
  });

  it('serves HTTPS, index.html at the root and for every route the app handles itself', () => {
    frontend.hasResourceProperties('AWS::CloudFront::Distribution', {
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

  it('sends a strict content policy: its own files, the API and the sign-in pages', () => {
    const [policy] = Object.values(frontend.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as {
      Properties: { ResponseHeadersPolicyConfig: { SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: string } } } };
    }[];
    const csp = policy!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://*.execute-api.us-west-2.amazonaws.com https://*.auth.us-west-2.amazoncognito.com");
    expect(csp).not.toContain('unsafe');
  });

  it('publishes the address in SSM', () => {
    frontend.hasResourceProperties('AWS::SSM::Parameter', { Name: '/hearth/dev/web-url', Type: 'String' });
  });
});

describe('WebContentStack', () => {
  const deployments = Object.values(content.findResources('Custom::CDKBucketDeployment')) as {
    Properties: { Prune: boolean; SystemMetadata?: Record<string, string>; DistributionPaths?: string[]; DestinationBucketName: unknown };
  }[];

  it('copies hashed assets for a year and everything else uncached into the site bucket, then invalidates', () => {
    expect(deployments).toHaveLength(2);
    expect(deployments.every((d) => d.Properties.Prune === false)).toBe(true);
    expect(deployments.every((d) => d.Properties.DestinationBucketName === 'hearth-dev-web-138300868928-us-west-2')).toBe(true);
    const caching = deployments.map((d) => d.Properties.SystemMetadata?.['cache-control']).sort();
    expect(caching).toEqual(['no-cache', 'public, max-age=31536000, immutable']);
    const entry = deployments.find((d) => d.Properties.SystemMetadata?.['cache-control'] === 'no-cache');
    expect(entry?.Properties.DistributionPaths).toEqual(['/*']);
  });

  it('writes config.json with the API and the web sign-in client', () => {
    // Source.jsonData uploads the file with markers, which the deploy fills in from the other stacks.
    const entry = Object.values(content.findResources('Custom::CDKBucketDeployment')).find(
      (d) => (d as { Properties: { SourceMarkers?: unknown[] } }).Properties.SourceMarkers?.length === 2,
    );
    const markers = JSON.stringify((entry as { Properties: { SourceMarkers: unknown[] } }).Properties.SourceMarkers);
    expect(markers).toContain('hearth-dev-Api'); // apiUrl
    expect(markers).toContain('.auth.us-west-2.amazoncognito.com'); // auth.domain
    expect(markers).toMatch(/UsersWeb/); // auth.clientId: the web client
    const auth = stack('WebContent').dependencies.map((d) => d.id);
    expect(auth).toEqual(expect.arrayContaining(['hearth-dev-Frontend', 'hearth-dev-Auth', 'hearth-dev-Api']));
  });

  it('refuses to synthesize without a web app build', () => {
    const bare = testApp();
    bare.node.setContext('webDist', '/no/such/build');
    expect(() => addEnvironment(bare, envConfig('dev'))).toThrow(/pnpm --filter @hearth\/web build/);
  });
});

describe('the API, for the web app', () => {
  it('lets the site (and Vite on dev) call it from a browser, with an ID token', () => {
    const [httpApi] = Object.values(api.findResources('AWS::ApiGatewayV2::Api')) as {
      Properties: { CorsConfiguration: { AllowOrigins: unknown[]; AllowHeaders: string[]; AllowMethods: string[] } };
    }[];
    const cors = httpApi!.Properties.CorsConfiguration;
    expect(cors.AllowOrigins).toHaveLength(2);
    expect(JSON.stringify(cors.AllowOrigins[0])).toContain('https://');
    expect(cors.AllowOrigins[1]).toBe('http://localhost:5173');
    expect(cors.AllowHeaders).toEqual(['authorization', 'content-type']);
    expect(cors.AllowMethods.sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST']);
  });
});
