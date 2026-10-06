import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Validations, type Size } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config.js';

export interface HearthFunctionProps {
  config: EnvConfig;
  /** Entry file, relative to the repo's services/ directory, e.g. `api/src/agent/lambda.ts`. */
  entry: string;
  handler: string;
  /** A fixed name, for functions people invoke by hand. */
  functionName?: string;
  environment?: Record<string, string>;
  timeout?: Duration;
  /** MB; defaults to 256. CPU scales with it. */
  memorySize?: number;
  /** /tmp space; defaults to Lambda's 512 MB. */
  ephemeralStorageSize?: Size;
  /** The code bundles CommonJS packages (e.g. yauzl) that call require(): give the bundle one. */
  commonJsDependencies?: boolean;
}

/** A TypeScript Lambda from services/: ARM, Node 24, bundled as ESM, logs kept 30 days. */
export function hearthFunction(scope: Construct, id: string, props: HearthFunctionProps): NodejsFunction {
  const fn = new NodejsFunction(scope, id, {
    entry: fileURLToPath(new URL(`../../services/${props.entry}`, import.meta.url)),
    handler: props.handler,
    functionName: props.functionName,
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: props.memorySize ?? 256,
    ...(props.ephemeralStorageSize ? { ephemeralStorageSize: props.ephemeralStorageSize } : {}),
    timeout: props.timeout ?? Duration.seconds(10),
    logGroup: new LogGroup(scope, `${id}Logs`, {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: props.config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }),
    environment: { ...props.environment, NODE_OPTIONS: '--enable-source-maps' },
    bundling: {
      format: OutputFormat.ESM,
      target: 'node24',
      sourceMap: true,
      // An ESM module has no require(); bundled CommonJS packages call it for Node built-ins.
      ...(props.commonJsDependencies
        ? { banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
        : {}),
    },
  });
  Validations.of(fn).acknowledge({
    id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    reason: 'AWS-maintained policy that only allows writing to CloudWatch Logs.',
  });
  return fn;
}
