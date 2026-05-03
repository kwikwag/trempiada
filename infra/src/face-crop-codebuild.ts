import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

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

const buildspec = `version: 0.2
phases:
  install:
    commands:
      - set -euo pipefail
      - |
        if command -v dnf >/dev/null 2>&1; then
          dnf install -y zip findutils gcc gcc-c++ make pkgconf-pkg-config openssl-devel
        elif command -v yum >/dev/null 2>&1; then
          yum install -y zip findutils gcc gcc-c++ make pkgconfig openssl-devel
        fi
      - |
        if ! command -v cargo >/dev/null 2>&1; then
          curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
        fi
  pre_build:
    commands:
      - set -euo pipefail
      - test -n "$SOURCE_BUCKET"
      - test -n "$SOURCE_KEY"
      - test -n "$OUTPUT_BUCKET"
      - test -n "$OUTPUT_KEY"
      - test -n "$FACE_CROP_ARCH"
      - aws s3 cp "s3://$SOURCE_BUCKET/$SOURCE_KEY" /tmp/face-crop-fast-source.tgz
      - mkdir -p /tmp/face-crop-fast-source
      - tar -xzf /tmp/face-crop-fast-source.tgz -C /tmp/face-crop-fast-source
  build:
    commands:
      - set -euo pipefail
      - if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
      - cd /tmp/face-crop-fast-source && bash scripts/build-lambda-zip.sh "$FACE_CROP_ARCH"
  post_build:
    commands:
      - set -euo pipefail
      - |
        echo "=== ORT shared lib glibc requirements ==="
        libort=$(find /tmp/face-crop-fast-source/target -maxdepth 3 -name 'libonnxruntime.so*' -not -type d 2>/dev/null | head -1)
        if [ -n "$libort" ]; then
          readelf -sW "$libort" | awk '/GLIBC_/{print $NF}' | sort -uV
        else
          echo "(no libonnxruntime.so found — tract-only build)"
        fi
      - |
        echo "=== bootstrap glibc requirements ==="
        bootstrap=$(find /tmp/face-crop-fast-source/target -name bootstrap -type f 2>/dev/null | head -1)
        [ -n "$bootstrap" ] && ldd "$bootstrap" | grep GLIBC || true
      - |
        echo "=== rejecting any symbol newer than GLIBC_2.34 ==="
        for f in \
          $(find /tmp/face-crop-fast-source/target -name bootstrap -o -name 'libonnxruntime.so*' 2>/dev/null); do
          bad=$(readelf -sW "$f" 2>/dev/null | grep -oP 'GLIBC_\d+\.\d+' | sort -uV | awk -F'[_.]' 'NR>1 || $2>2 || ($2==2 && $3>34) {print}' || true)
          if [ -n "$bad" ]; then
            echo "FAIL: $f requires $bad (> GLIBC_2.34)" >&2
            exit 1
          fi
        done
        echo "glibc check passed"
      - aws s3 cp "/tmp/face-crop-fast-source/dist/face-crop-fast-$FACE_CROP_ARCH.zip" "s3://$OUTPUT_BUCKET/$OUTPUT_KEY"
`;

export function createFaceCropCodeBuild(args: {
  resourcePrefix: string;
  architecture: FaceCropArchitecture;
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
