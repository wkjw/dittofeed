import {
  ExplicitBucketHistogramAggregation,
  InstrumentType,
  View,
} from "@opentelemetry/sdk-metrics";
import {
  makeWorkflowExporter,
  OpenTelemetryActivityInboundInterceptor,
} from "@temporalio/interceptors-opentelemetry/lib/worker";
import {
  appendDefaultInterceptors,
  defaultSinks,
  NativeConnection,
  Runtime,
  Worker,
  WorkerOptions,
} from "@temporalio/worker";
import backendConfig from "backend-lib/src/config";
import { WORKSPACE_COMPUTE_LATENCY_METRIC } from "backend-lib/src/constants";
import logger from "backend-lib/src/logger";
import { initOpenTelemetry } from "backend-lib/src/openTelemetry";
import * as activities from "backend-lib/src/temporal/activities";
import { CustomActivityInboundInterceptor } from "backend-lib/src/temporal/activityInboundInterceptor";
import connectWorkflowCLient from "backend-lib/src/temporal/connectWorkflowClient";
import workerLogger from "backend-lib/src/workerLogger";

import config from "../src/config";

async function run() {
  const workerConfig = config();

  if (backendConfig().logConfig) {
    logger().info(
      {
        ...backendConfig(),
        ...workerConfig,
      },
      "Initialized with config",
    );
  }
  const otel = initOpenTelemetry({
    serviceName: workerConfig.workerServiceName,
    meterProviderViews: [
      new View({
        aggregation: new ExplicitBucketHistogramAggregation([
          500, 1000, 1500, 5000, 10000, 15000, 30000, 45000, 60000, 90000,
          120000, 180000, 240000, 300000, 600000, 1800000, 3600000, 86400000,
          604800000,
        ]),
        instrumentName: WORKSPACE_COMPUTE_LATENCY_METRIC,
        instrumentType: InstrumentType.HISTOGRAM,
      }),
    ],
  });

  Runtime.install({ logger: workerLogger });

  const [connection, workflowClient] = await Promise.all([
    NativeConnection.connect({
      address: backendConfig().temporalAddress,
    }),
    connectWorkflowCLient(),
  ]);

  const {
    maxConcurrentWorkflowTaskExecutions,
    maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls,
    taskQueue,
    maxCachedWorkflows,
    reuseContext: reuseV8Context,
  } = config();

  const opts: WorkerOptions = {
    connection,
    namespace: backendConfig().temporalNamespace,
    workflowsPath: require.resolve("backend-lib/src/temporal/workflows"),
    activities,
    sinks: {
      ...defaultSinks(workerLogger),
      exporter: makeWorkflowExporter(otel.traceExporter, otel.resource),
    },
    interceptors: appendDefaultInterceptors(
      {
        activityInbound: [
          (ctx) =>
            new CustomActivityInboundInterceptor(ctx, {
              workflowClient,
            }),
          (ctx) => new OpenTelemetryActivityInboundInterceptor(ctx),
        ],
      },
      workerLogger,
    ),
    enableSDKTracing: true,
    taskQueue,
  };

  if (reuseV8Context) {
    opts.reuseV8Context = reuseV8Context;
  }

  if (maxConcurrentWorkflowTaskExecutions) {
    opts.maxConcurrentWorkflowTaskExecutions =
      maxConcurrentWorkflowTaskExecutions;
  }

  if (maxConcurrentActivityTaskPolls) {
    opts.maxConcurrentActivityTaskPolls = maxConcurrentActivityTaskPolls;
  }

  if (maxConcurrentWorkflowTaskPolls) {
    opts.maxConcurrentWorkflowTaskPolls = maxConcurrentWorkflowTaskPolls;
  }

  if (maxCachedWorkflows) {
    opts.maxCachedWorkflows = maxCachedWorkflows;
  }

  const worker = await Worker.create(opts);

  otel.start();

  logger().info(
    {
      opts,
    },
    "Worker started",
  );
  await worker.run();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
