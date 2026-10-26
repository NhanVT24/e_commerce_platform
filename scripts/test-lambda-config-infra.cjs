const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
require("ts-node").register({ project: path.join(root, "infra/tsconfig.json"), transpileOnly: true });
const cdk = require("aws-cdk-lib");
const { Template } = require("aws-cdk-lib/assertions");
const { AwsApiStack } = require("../infra/stack/aws-api-stack.ts");
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lambda-config-synth-"));

try {
  const app = new cdk.App({ outdir: temporary });
  const stack = new AwsApiStack(app, "SupermarketAwsStack", { env: { account: "111111111111", region: "ap-southeast-1" } });
  const template = Template.fromStack(stack).toJSON();
  const resources = template.Resources;
  const paymentFunctions = new Set([
    "supermarket-http-api-aws", "supermarket-order-workflow-step-aws",
    "supermarket-reconcile-pending-refunds-aws", "supermarket-reconcile-payment-events-aws"
  ]);
  const databaseOnlyFunctions = new Set([
    "supermarket-email-route-tracker-aws", "supermarket-ses-inventory-event-aws",
    "supermarket-payment-workflow-step-aws", "supermarket-release-expired-orders-aws",
    "supermarket-data-cleanup-aws", "supermarket-sale-campaign-worker-aws"
  ]);

  // Resolve supported CloudFormation intrinsics using deterministic, realistic
  // fixtures. Never use live credentials or print values. This is NOT a live
  // measurement: deployed parameter values and generated names may be longer.
  function resolve(value) {
    if (typeof value === "string") {
      return value.replace(/\{\{resolve:ssm(?:-secure)?:([^}]+)\}\}/g, (_, parameter) => {
        if (parameter.includes("hash-secret")) return "a".repeat(64);
        if (parameter.includes("tmn-code")) return "TESTCODE";
        if (parameter.includes("payment-url")) return "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
        throw new Error("Unsupported SSM fixture");
      });
    }
    if (value.Ref) {
      const pseudo = { "AWS::AccountId": "111111111111", "AWS::Region": "ap-southeast-1", "AWS::Partition": "aws", "AWS::URLSuffix": "amazonaws.com" };
      if (pseudo[value.Ref]) return pseudo[value.Ref];
      if (template.Parameters[value.Ref]) {
        assert.ok("Default" in template.Parameters[value.Ref], `Parameter fixture needed: ${value.Ref}`);
        return String(template.Parameters[value.Ref].Default);
      }
      const resource = resources[value.Ref];
      assert.ok(resource, `Unknown Ref ${value.Ref}`);
      const props = resource.Properties ?? {};
      switch (resource.Type) {
        case "AWS::DynamoDB::Table": return resolve(props.TableName);
        case "AWS::SQS::Queue": return `https://sqs.ap-southeast-1.amazonaws.com/111111111111/${resolve(props.QueueName)}`;
        case "AWS::SNS::Topic": return `arn:aws:sns:ap-southeast-1:111111111111:${resolve(props.TopicName)}`;
        case "AWS::Events::EventBus": return resolve(props.Name);
        case "AWS::Scheduler::ScheduleGroup": return resolve(props.Name);
        case "AWS::SES::ConfigurationSet": return resolve(props.Name);
        case "AWS::Cognito::UserPool": return "ap-southeast-1_TestPool";
        case "AWS::Cognito::UserPoolClient": return "a".repeat(26);
        case "AWS::S3::Bucket": return "supermarketawsstack-productimagesbucket03bda4c8-abcdefghijkl";
        default: throw new Error(`Unsupported Ref fixture ${value.Ref}: ${resource.Type}`);
      }
    }
    if (value["Fn::Join"]) return resolve(value["Fn::Join"][1].map(resolve).join(value["Fn::Join"][0]));
    if (value["Fn::GetAtt"]) {
      const [id, attribute] = value["Fn::GetAtt"];
      const resource = resources[id], props = resource.Properties ?? {};
      if (attribute === "DomainName" && resource.Type === "AWS::CloudFront::Distribution") return "d1234567890123.cloudfront.net";
      if (attribute === "Arn") {
        if (resource.Type === "AWS::Events::Archive") return `arn:aws:events:ap-southeast-1:111111111111:archive/${resolve(props.ArchiveName)}`;
        if (resource.Type === "AWS::Lambda::Function") return `arn:aws:lambda:ap-southeast-1:111111111111:function:${resolve(props.FunctionName)}`;
        if (resource.Type === "AWS::IAM::Role") return `arn:aws:iam::111111111111:role/SupermarketAwsStack-${id}-ABCDEFGHIJKL`;
      }
      throw new Error(`Unsupported GetAtt fixture ${id}.${attribute}`);
    }
    throw new Error("Unsupported environment intrinsic; add an explicit fixture");
  }

  const applicationFunctions = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("Supermarket") && resource.Properties.FunctionName.endsWith("-aws"));
  assert.equal(applicationFunctions.length, 23);
  let largest = { bytes: 0, name: "" };
  for (const [id, resource] of applicationFunctions) {
    const name = resource.Properties.FunctionName;
    const variables = resource.Properties.Environment?.Variables ?? {};
    const fixture = Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, resolve(value)]));
    const bytes = Object.entries(fixture).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
    assert.ok(bytes <= 4096, `${name} exceeds 4 KiB in the fixture: ${bytes} bytes`);
    if (bytes > largest.bytes) largest = { bytes, name };
    assert.equal("VNPAY_HASH_SECRET" in variables, paymentFunctions.has(name), `${name}: payment secret scope`);
    if (databaseOnlyFunctions.has(name)) {
      assert.ok("DYNAMODB_TABLE_NAME" in variables);
      assert.ok(!Object.keys(variables).some(key => key !== "SES_EVENTS_TOPIC_ARN" && /^(SES_|S3_|SQS_|EVENTBRIDGE_|VNPAY_)/.test(key)), `${name}: unexpected integration config`);
    }

    const role = resource.Properties.Role["Fn::GetAtt"][0];
    const statements = Object.values(resources).filter(candidate => candidate.Type === "AWS::IAM::Policy" && candidate.Properties.Roles?.some(item => item.Ref === role))
      .flatMap(policy => policy.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap(statement => [].concat(statement.Action));
    if (name !== "supermarket-http-api-aws") {
      assert.ok(!actions.some(action => /^(scheduler:|iam:|cognito-idp:|s3:)|^events:(StartReplay|DescribeReplay)$/.test(action)), `${name}: administrative/storage privileges leaked`);
      assert.ok(!Object.keys(variables).some(key => key.startsWith("SQS_")), `${name}: admin queues leaked`);
    }
    if (["supermarket-payment-workflow-step-aws", "supermarket-build-weekly-report-aws"].includes(name)) {
      assert.ok(actions.includes("dynamodb:GetItem"));
      assert.ok(!actions.some(action => /^dynamodb:(Put|Update|Delete|TransactWrite|BatchWrite)/.test(action)), `${name}: write permission on read-only function`);
    }
    if (["supermarket-audit-event-worker-aws", "supermarket-image-workflow-step-aws"].includes(name)) assert.equal(actions.length, 0);
    if (name === "supermarket-email-worker-aws") {
      assert.ok(actions.includes("ses:SendEmail"));
      assert.ok(actions.includes("dynamodb:UpdateItem"));
      assert.ok(!actions.some(action => /^(events:|sns:)/.test(action)));
    }

    const handlerFile = path.join(root, "apps/api/dist", resource.Properties.Handler.replace(/\.handler$/, ".js"));
    assert.ok(fs.existsSync(handlerFile), "Build the API before testing Lambda initialization");
    const needsContext = /\/(queue\/(order|payment|notification|image-upload)-worker|jobs\/(release-expired-orders|reconcile-pending-refunds|reconcile-payment-events)|workflow\/(order|payment)-workflow-step)\.js$/.test(handlerFile.replaceAll("\\", "/"));
    const code = `
      import assert from 'node:assert/strict';
      // Fail immediately if initialization or an empty invocation tries AWS I/O.
      for (const [pkg, client] of [
        ['dynamodb','DynamoDBClient'], ['s3','S3Client'], ['sqs','SQSClient'],
        ['sns','SNSClient'], ['sesv2','SESv2Client'], ['eventbridge','EventBridgeClient'],
        ['scheduler','SchedulerClient'], ['cognito-identity-provider','CognitoIdentityProviderClient']
      ]) {
        const mod = await import('@aws-sdk/client-' + pkg);
        mod[client].prototype.send = () => { throw new Error('Unexpected AWS I/O in bootstrap test: ' + client); };
      }
      const {handler} = await import(${JSON.stringify(pathToFileURL(handlerFile).href)});
      assert.equal(typeof handler, 'function');
      ${name === "supermarket-email-worker-aws" ? `const {readPaymentConfig} = await import(${JSON.stringify(pathToFileURL(path.join(root, "apps/api/dist/src/config/payment-config.js")).href)}); assert.throws(() => readPaymentConfig(), error => error.name === 'ZodError');` : ""}
      ${resource.Properties.Handler.includes("/queue/") ? "assert.deepEqual(await handler({Records:[]}), {batchItemFailures:[]});" : ""}
      ${needsContext ? `const {createStandaloneContext} = await import(${JSON.stringify(pathToFileURL(path.join(root, "apps/api/dist/src/core/app/create-standalone-context.js")).href)}); await (await createStandaloneContext()).close();` : ""}
      ${name === "supermarket-http-api-aws" ? `const response = await handler({version:'2.0',routeKey:'GET /health',rawPath:'/health',rawQueryString:'',headers:{host:'localhost'},requestContext:{http:{method:'GET',path:'/health',sourceIp:'127.0.0.1',protocol:'HTTP/1.1'}}},{}); assert.ok([200,404].includes(response.statusCode));` : ""}
    `;
    const inherited = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, timeout: 30000, encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { ...inherited, ...fixture, AWS_REGION: "ap-southeast-1", AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture", AWS_EC2_METADATA_DISABLED: "true", AWS_LAMBDA_FUNCTION_NAME: name }
    });
    assert.equal(result.status, 0, `${name}: scoped bootstrap failed\n${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
    console.log(`PASS ${name}: scoped bootstrap, environment (${bytes} fixture bytes), permissions`);
  }
  console.log(`23 Lambda profiles PASS. Largest fixture: ${largest.name}, ${largest.bytes}/4096 bytes. No live AWS verification.`);
} finally {
  const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("lambda-config-synth-")) throw new Error("Unsafe synthesis cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
}
