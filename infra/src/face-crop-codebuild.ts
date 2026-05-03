import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

type FaceCropArchitecture = "x86_64" | "arm64";

export type FaceCropCodeBuildResult = {
  artifactBucket: aws.s3.BucketV2;
  project: aws.codebuild.Project;
};

function codeBuildImageForArchitecture(architecture: FaceCropArchitecture): string {
  return architecture === "arm64"
    ? "aws/codebuild/amazonlinux-aarch64-standard:3.0"
    : "aws/codebuild/amazonlinux-x86_64-standard:5.0";
}

function codeBuildEnvironmentTypeForArchitecture(architecture: FaceCropArchitecture): string {
  return architecture === "arm64" ? "ARM_CONTAINER" : "LINUX_CONTAINER";
}

const buildspec = fs.readFileSync(
  path.join(__dirname, "lambda/face-crop-fast/buildspec.yml"),
  "utf8",
);

export function createFaceCropCodeBuild(args: {
  resourcePrefix: string;
  architecture: FaceCropArchitecture;
  /** Enable S3 caching of Cargo registry/git to speed up repeat builds. Off by default. */
  enableBuildCache?: boolean;
}): FaceCropCodeBuildResult {
  const artifactBucket = new aws.s3.BucketV2("face-crop-build-artifacts", {
    bucket: `${args.resourcePrefix}-face-crop-build-artifacts`,
    forceDestroy: true,
  });

  const role = new aws.iam.Role("face-crop-codebuild-role", {
    name: `${args.resourcePrefix}-face-crop-codebuild-role`,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "codebuild.amazonaws.com",
    }),
  });

  new aws.iam.RolePolicy("face-crop-codebuild-policy", {
    role: role.name,
    policy: pulumi.all([artifactBucket.arn]).apply(([artifactBucketArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: `${artifactBucketArn}/*`,
          },
        ],
      }),
    ),
  });

  const project = new aws.codebuild.Project("face-crop-codebuild-project", {
    name: `${args.resourcePrefix}-face-crop-build`,
    serviceRole: role.arn,
    artifacts: {
      type: "NO_ARTIFACTS",
    },
    cache: args.enableBuildCache
      ? {
          type: "S3",
          location: pulumi.interpolate`${artifactBucket.bucket}/cargo-cache/${args.architecture}`,
        }
      : { type: "NO_CACHE" },
    environment: {
      computeType: "BUILD_GENERAL1_MEDIUM",
      image: codeBuildImageForArchitecture(args.architecture),
      type: codeBuildEnvironmentTypeForArchitecture(args.architecture),
    },
    source: {
      type: "NO_SOURCE",
      buildspec,
    },
    queuedTimeout: 60,
    buildTimeout: 60,
  });

  return {
    artifactBucket,
    project,
  };
}
