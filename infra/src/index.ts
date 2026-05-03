import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { createBootstrapApi } from "./api";
import { createBotIdentityPolicy } from "./bot-policy";
import { createBrowserSessionRole } from "./browser-role";
import { getLivenessConfig } from "./config";
import { createTokenTable } from "./dynamodb";
import { createFaceCropCodeBuild } from "./face-crop-codebuild";
import { createFaceCropLambda } from "./face-crop-lambda";
import { createBootstrapLambda } from "./lambda";
import * as path from "path";

const config = getLivenessConfig();
const tokenTable = createTokenTable({
  resourcePrefix: config.resourcePrefix,
});
const browserSessionRole = createBrowserSessionRole({
  resourcePrefix: config.resourcePrefix,
  trustedPrincipalArns: config.bootstrapRoleTrustedPrincipalArns,
});
const faceCropCodeBuild = createFaceCropCodeBuild({
  resourcePrefix: config.resourcePrefix,
  architecture: config.faceCropArchitecture,
  enableBuildCache: config.faceCropBuildCache,
});
const faceCropLambda = createFaceCropLambda({
  resourcePrefix: config.resourcePrefix,
  watermarkLocalPath: `${__dirname}/lambda/face-crop-fast/watermark.png`,
  architecture: config.faceCropArchitecture,
  codeS3Bucket: config.faceCropCodeS3Bucket,
  codeS3Key: config.faceCropCodeS3Key,
  zipLocalPath:
    config.faceCropZipLocalPath ??
    path.resolve(
      __dirname,
      `lambda/face-crop-fast/dist/face-crop-fast-${config.faceCropArchitecture}.zip`,
    ),
});
const botIdentityPolicy = createBotIdentityPolicy({
  resourcePrefix: config.resourcePrefix,
  tokenTableArn: tokenTable.table.arn,
  browserSessionRoleArn: browserSessionRole.role.arn,
  faceCropLambdaArn: faceCropLambda.function.arn,
});
const bootstrapLambda = createBootstrapLambda({
  resourcePrefix: config.resourcePrefix,
  tokenTable: tokenTable.table,
  corsAllowOrigins: config.corsAllowOrigins,
});
const bootstrapApi = createBootstrapApi({
  resourcePrefix: config.resourcePrefix,
  bootstrapLambda: bootstrapLambda.function,
  corsAllowOrigins: config.corsAllowOrigins,
});

const livenessAppUrlTemplateOutput = pulumi.interpolate`${config.livenessPageBaseUrl}/?token={token}`;

export const awsRegion = aws.config.region;
export const environment = config.environment;
export const tokenTableName = tokenTable.table.name;
export const tokenTableArn = tokenTable.table.arn;
export const browserSessionRoleArn = browserSessionRole.role.arn;
export const botPolicyArn = botIdentityPolicy.policy.arn;
export const botPolicyDocument = botIdentityPolicy.document;
export const bootstrapRoleArn = bootstrapLambda.role.arn;
export const bootstrapFunctionName = bootstrapLambda.function.name;
export const bootstrapApiId = bootstrapApi.api.id;
export const bootstrapApiUrl = bootstrapApi.stage.invokeUrl;
export const bootstrapEndpointUrl = bootstrapApi.bootstrapUrl;
export const livenessPageBaseUrl = config.livenessPageBaseUrl;
export const livenessAppUrlTemplate = livenessAppUrlTemplateOutput;
export const faceCropLambdaArn = faceCropLambda.function.arn;
export const faceCropLambdaName = faceCropLambda.function.name;
export const faceCropArchitecture = config.faceCropArchitecture;
export const faceCropBuildBucket = faceCropCodeBuild.artifactBucket.bucket;
export const faceCropBuildProjectName = faceCropCodeBuild.project.name;
export const faceCropWatermarkBucket = faceCropLambda.watermarkBucketName;
export const faceCropWatermarkKey = faceCropLambda.watermarkKey;
export const botEnv = {
  AWS_REGION: aws.config.region,
  AWS_LIVENESS_ROLE_ARN: browserSessionRole.role.arn,
  AWS_LIVENESS_BOOTSTRAP_TABLE: tokenTable.table.name,
  AWS_LIVENESS_PAGES_URL: config.livenessPageBaseUrl,
  AWS_LIVENESS_TOKEN_TTL_SECONDS: String(config.tokenTtlSeconds),
  AWS_FACE_CROP_LAMBDA_NAME: faceCropLambda.function.name,
  AWS_WATERMARK_BUCKET: faceCropLambda.watermarkBucketName,
  AWS_WATERMARK_KEY: faceCropLambda.watermarkKey,
};
export const webEnv = {
  VITE_LIVENESS_BOOTSTRAP_URL: bootstrapApi.bootstrapUrl,
};
