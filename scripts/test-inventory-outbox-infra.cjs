const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const cp = require("node:child_process");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
require("ts-node").register({ project: path.join(root, "infra/tsconfig.json"), transpileOnly: true });
const cdk = require("aws-cdk-lib");
const { Template } = require("aws-cdk-lib/assertions");
const stackPath = path.join(root, "infra/stack/aws-api-stack.ts");
const { AwsApiStack } = require(stackPath);
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "inventory-outbox-synth-"));
function synth(StackClass, name) {
  const app = new cdk.App({ outdir: path.join(temporary, name) });
  const stack = new StackClass(app, "SupermarketAwsStack", { env: { account: "111111111111", region: "ap-southeast-1" } });
  const template = Template.fromStack(stack).toJSON();
  app.synth();
  return template;
}
try {
  const current = synth(AwsApiStack, "current");
  const resources = Object.entries(current.Resources);
  const [relayId, relay] = resources.find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("InventoryAlertOutboxRelayFunction"));
  assert.equal(relay.Properties.Handler, "src/entrypoints/lambda/jobs/inventory-alert-relay.handler");
  assert.equal(relay.Properties.Timeout, 30);
  assert.deepEqual(Object.keys(relay.Properties.Environment.Variables).sort(), ["DYNAMODB_TABLE_NAME", "EVENTBRIDGE_PLATFORM_BUS_NAME"]);
  assert.equal(current.Parameters.InventoryAlertOutboxEnabled.Default, "false");
  assert.deepEqual(current.Parameters.InventoryAlertOutboxEnabled.AllowedValues, ["true", "false"]);
  const policy = resources.find(([id, resource]) => resource.Type === "AWS::IAM::Policy" && id.startsWith("InventoryAlertOutboxRelayFunction"))[1];
  const allowed = new Set(["dynamodb:Query", "dynamodb:UpdateItem", "events:PutEvents"]);
  for (const statement of policy.Properties.PolicyDocument.Statement) {
    for (const action of [].concat(statement.Action)) assert.ok(allowed.has(action), `Unexpected relay privilege ${action}`);
    assert.ok(![].concat(statement.Resource).includes("*"));
  }
  const schedule = resources.find(([id, resource]) => id.startsWith("InventoryAlertOutboxRelaySchedule") && resource.Type === "AWS::Events::Rule")[1];
  assert.equal(schedule.Properties.ScheduleExpression, "rate(1 minute)");
  assert.deepEqual(schedule.Properties.Targets[0].Arn, { "Fn::GetAtt": [relayId, "Arn"] });
  assert.ok(resources.some(([id, resource]) => id.startsWith("InventoryAlertOutboxFailedEvents") && resource.Type === "AWS::CloudWatch::Alarm"));
  const api = resources.find(([id, resource]) => id.startsWith("SupermarketHttpApiFunction") && resource.Type === "AWS::Lambda::Function")[1];
  assert.deepEqual(api.Properties.Environment.Variables.INVENTORY_ALERT_OUTBOX_ENABLED, { Ref: "InventoryAlertOutboxEnabled" });
  if (process.argv[2]) {
    const previous = cp.execFileSync("git", ["show", `${process.argv[2]}:infra/stack/aws-api-stack.ts`], { cwd: root, encoding: "utf8" });
    const baselineModule = new Module(stackPath, module);
    baselineModule.filename = stackPath; baselineModule.paths = Module._nodeModulePaths(path.dirname(stackPath));
    baselineModule._compile(ts.transpileModule(previous, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, stackPath);
    const baseline = synth(baselineModule.exports.AwsApiStack, "baseline");
    for (const [id, resource] of Object.entries(baseline.Resources)) {
      assert.ok(current.Resources[id], `Existing resource ID removed: ${id}`);
      if (resource.Type === "AWS::DynamoDB::Table") assert.deepEqual(current.Resources[id], resource, "Existing table/index definition changed");
      if (resource.Type === "AWS::Lambda::Function") assert.equal(current.Resources[id].Properties.Handler, resource.Properties.Handler);
    }
    console.log(`Baseline ${process.argv[2]}: all ${Object.keys(baseline.Resources).length} existing resource IDs retained; table/index definitions unchanged.`);
  }
  console.log("Inventory outbox synth: handler, schedule, flag, alarm and least-privilege checks PASS. No AWS deployment.");
} finally {
  const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("inventory-outbox-synth-")) throw new Error("Unsafe synthesis cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
}
