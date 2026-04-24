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
  };
}
