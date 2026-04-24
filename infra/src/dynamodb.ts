import * as aws from "@pulumi/aws";

export type TokenTable = {
  table: aws.dynamodb.Table;
};

export function createTokenTable(args: { resourcePrefix: string }): TokenTable {
  const table = new aws.dynamodb.Table("liveness-token-table", {
    name: `${args.resourcePrefix}-liveness-tokens`,
    billingMode: "PAY_PER_REQUEST",
    hashKey: "token",
    attributes: [
      {
        name: "token",
        type: "S",
      },
    ],
    ttl: {
      attributeName: "ttl",
      enabled: true,
    },
    pointInTimeRecovery: {
      enabled: true,
    },
    serverSideEncryption: {
      enabled: true,
    },
    tags: {
      feature: "liveness",
    },
  });

  return { table };
}
