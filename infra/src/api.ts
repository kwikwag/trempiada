import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type BootstrapApi = {
  api: aws.apigatewayv2.Api;
  stage: aws.apigatewayv2.Stage;
  integration: aws.apigatewayv2.Integration;
  route: aws.apigatewayv2.Route;
  permission: aws.lambda.Permission;
  bootstrapUrl: pulumi.Output<string>;
};

export function createBootstrapApi(args: {
  resourcePrefix: string;
  bootstrapLambda: aws.lambda.Function;
  corsAllowOrigins: string[];
}): BootstrapApi {
  const callerIdentity = aws.getCallerIdentityOutput({});
  const region = aws.getRegionOutput({});
  const partition = aws.getPartitionOutput({});

  const api = new aws.apigatewayv2.Api("liveness-http-api", {
    name: `${args.resourcePrefix}-liveness`,
    protocolType: "HTTP",
    corsConfiguration: {
      allowHeaders: ["content-type"],
      allowMethods: ["OPTIONS", "POST"],
      allowOrigins: args.corsAllowOrigins,
      maxAge: 300,
    },
  });

  const integration = new aws.apigatewayv2.Integration("liveness-bootstrap-integration", {
    apiId: api.id,
    integrationType: "AWS_PROXY",
    integrationMethod: "POST",
    integrationUri: args.bootstrapLambda.invokeArn,
    payloadFormatVersion: "2.0",
  });

  const route = new aws.apigatewayv2.Route("liveness-bootstrap-route", {
    apiId: api.id,
    routeKey: "POST /bootstrap",
    target: pulumi.interpolate`integrations/${integration.id}`,
  });

  const stage = new aws.apigatewayv2.Stage("liveness-http-stage", {
    apiId: api.id,
    name: "$default",
    autoDeploy: true,
  });

  const permission = new aws.lambda.Permission("liveness-http-api-permission", {
    action: "lambda:InvokeFunction",
    function: args.bootstrapLambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`arn:${partition.partition}:execute-api:${region.name}:${callerIdentity.accountId}:${api.id}/*/*`,
  });

  return {
    api,
    stage,
    integration,
    route,
    permission,
    bootstrapUrl: pulumi.interpolate`${stage.invokeUrl}/bootstrap`,
  };
}
