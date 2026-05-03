import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export type LivenessConfig = {
  environment: string;
  projectName: string;
  stackName: string;
  resourcePrefix: string;
  livenessPageBaseUrl: string;
  tokenTtlSeconds: number;
  corsAllowOrigins: string[];
  bootstrapRoleTrustedPrincipalArns: pulumi.Input<string[]>;
  faceCropArchitecture: "x86_64" | "arm64";
  faceCropZipLocalPath?: string;
  faceCropCodeS3Bucket?: string;
  faceCropCodeS3Key?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getLivenessConfig(): LivenessConfig {
  const config = new pulumi.Config();
  const environment = config.get("environment") ?? pulumi.getStack();
  const livenessPageBaseUrl = trimTrailingSlash(config.require("livenessPageBaseUrl"));
  const tokenTtlSeconds = config.getNumber("tokenTtlSeconds") ?? 180;
  const corsAllowOrigins = config.getObject<string[]>("corsAllowOrigins") ?? ["*"];
  const faceCropArchitecture = config.get("faceCropArchitecture") ?? "x86_64";
  if (faceCropArchitecture !== "x86_64" && faceCropArchitecture !== "arm64") {
    throw new Error("faceCropArchitecture must be either 'x86_64' or 'arm64'");
  }
  const faceCropZipLocalPath = config.get("faceCropZipLocalPath");
  const faceCropCodeS3Bucket = config.get("faceCropCodeS3Bucket");
  const faceCropCodeS3Key = config.get("faceCropCodeS3Key");
  if (
    (faceCropCodeS3Bucket && !faceCropCodeS3Key) ||
    (!faceCropCodeS3Bucket && faceCropCodeS3Key)
  ) {
    throw new Error("faceCropCodeS3Bucket and faceCropCodeS3Key must be set together");
  }
  const bootstrapRoleTrustedPrincipalArns =
    config.getObject<string[]>("bootstrapRoleTrustedPrincipalArns") ??
    aws
      .getCallerIdentityOutput({})
      .accountId.apply((accountId) => [`arn:aws:iam::${accountId}:root`]);
  const projectName = pulumi.getProject();
  const stackName = pulumi.getStack();
  const resourcePrefix = `${projectName}-${environment}`;

  return {
    environment,
    projectName,
    stackName,
    resourcePrefix,
    livenessPageBaseUrl,
    tokenTtlSeconds,
    corsAllowOrigins,
    bootstrapRoleTrustedPrincipalArns,
    faceCropArchitecture,
    faceCropZipLocalPath,
    faceCropCodeS3Bucket,
    faceCropCodeS3Key,
  };
}
