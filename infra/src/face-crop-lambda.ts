import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type FaceCropLambdaResult = {
  role: aws.iam.Role;
  function: aws.lambda.Function;
  watermarkBucketName: pulumi.Output<string>;
  watermarkKey: string;
};

type FaceCropArchitecture = "x86_64" | "arm64";

export function createFaceCropLambda(args: {
  resourcePrefix: string;
  architecture: FaceCropArchitecture;
  /** Absolute path to the prebuilt Lambda ZIP artifact. */
  zipLocalPath?: string;
  /** S3 location of the prebuilt Lambda ZIP artifact, preferred for CodeBuild output. */
  codeS3Bucket?: pulumi.Input<string>;
  codeS3Key?: pulumi.Input<string>;
  /** Absolute path to the watermark PNG to upload to S3. */
  watermarkLocalPath: string;
  watermarkS3Key?: string;
}): FaceCropLambdaResult {
  const watermarkKey = args.watermarkS3Key ?? "assets/watermark.png";

  // S3 bucket for the watermark PNG (and any future static assets).
  const assetsBucket = new aws.s3.BucketV2("face-crop-assets", {
    bucket: `${args.resourcePrefix}-face-crop-assets`,
    forceDestroy: true,
  });

  new aws.s3.BucketObjectv2("face-crop-watermark", {
    bucket: assetsBucket.id,
    key: watermarkKey,
    source: new pulumi.asset.FileAsset(args.watermarkLocalPath),
    contentType: "image/png",
  });

  // IAM execution role.
  const role = new aws.iam.Role("face-crop-lambda-role", {
    name: `${args.resourcePrefix}-face-crop-role`,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "lambda.amazonaws.com",
    }),
  });

  new aws.iam.RolePolicyAttachment("face-crop-basic-execution", {
    role: role.name,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
  });

  // Allow the lambda to read the assets bucket (watermark + any future assets).
  new aws.iam.RolePolicy("face-crop-s3-read", {
    role: role.name,
    policy: assetsBucket.arn.apply((arn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: `${arn}/*`,
          },
        ],
      }),
    ),
  });

  const codeSource =
    args.codeS3Bucket && args.codeS3Key
      ? {
          s3Bucket: args.codeS3Bucket,
          s3Key: args.codeS3Key,
        }
      : args.zipLocalPath
        ? {
            code: new pulumi.asset.FileArchive(args.zipLocalPath),
          }
        : undefined;
  if (!codeSource) {
    throw new Error("Either zipLocalPath or codeS3Bucket/codeS3Key must be provided");
  }

  // Lambda function (ZIP package, CPU-only ML inference).
  // NOTE: SnapStart is not supported for the provided.al2023 (Rust) runtime.
  //       Use Provisioned Concurrency if sub-second cold starts are needed.
  const fn = new aws.lambda.Function("face-crop-function", {
    name: `${args.resourcePrefix}-face-crop`,
    role: role.arn,
    runtime: "provided.al2023",
    handler: "bootstrap",
    ...codeSource,
    architectures: [args.architecture],
    timeout: 60,
    memorySize: 2048,
    environment: {
      variables: {
        LD_LIBRARY_PATH: "/var/task",
      },
    },
  });

  return {
    role,
    function: fn,
    watermarkBucketName: assetsBucket.bucket,
    watermarkKey,
  };
}
