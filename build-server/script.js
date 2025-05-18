const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const Redis = require("ioredis");
const { execSync } = require("child_process");
const archiver = require("archiver");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  PublishLayerVersionCommand,
  AddPermissionCommand,
  GetFunctionCommand,
} = require("@aws-sdk/client-lambda");
const {
  APIGatewayClient,
  CreateRestApiCommand,
  GetRestApisCommand,
  GetResourcesCommand,
  CreateResourceCommand,
  PutMethodCommand,
  PutIntegrationCommand,
  CreateDeploymentCommand,
  DeleteRestApiCommand,
  GetMethodCommand,
} = require("@aws-sdk/client-api-gateway");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");

function sanitizeProjectName(input) {
  return input
    .toLowerCase() // lowercase everything
    .replace(/[^a-z0-9-]/g, "-") // replace non-allowed chars with '-'
    .replace(/-+/g, "-") // collapse multiple '-' into one
    .replace(/^-+|-+$/g, "") // trim leading/trailing '-'
    .slice(0, 58); // limit to 58 characters
}

const PROJECT_NAME = sanitizeProjectName(process.env.PROJECT_ID);
const PROJECT_ID = PROJECT_NAME;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const TASK = process.env.TASK;

const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.BUCKET;
const LAMBDA_ROLE_ARN = process.env.LAMBDA_ROLE_ARN;

if (TASK === "static") {
  // --- Added: Parse ENVVARS and validate ---
  let envVars;
  try {
    envVars = JSON.parse(process.env.ENVVARS || "{}");
  } catch (err) {
    console.error(`Failed to parse ENVVARS: ${err.message}`);
    process.exit(1);
  }

  // --- End Added ---

  // Connection timeout to ensure Redis doesn't keep process alive indefinitely
  const publisher = new Redis({
    port: 6379,
    host: "3.109.186.255",
    connectTimeout: 10000, // 10 seconds
    maxRetriesPerRequest: 3,
  });

  // Handle Redis connection errors
  publisher.on("error", (err) => {
    console.error(`Redis error: ${err.message}`);
    cleanup(`Redis connection failed: ${err.message}`, 1);
  });

  function publishLog(log) {
    try {
      publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
    } catch (err) {
      console.error(`Failed to publish log: ${err.message}`);
    }
  }

  // Centralized cleanup function to ensure proper shutdown
  function cleanup(message, exitCode = 0) {
    console.log(message);
    if (publisher) {
      publisher.disconnect();
    }

    // Force exit after a timeout if something is still keeping the process alive
    setTimeout(() => {
      console.log("Forcing process exit after timeout");
      process.exit(exitCode);
    }, 3000);
  }

  async function init() {
    console.log("Executing script.js -New changed ");
    publishLog("New Build Started...");

    try {
      const outDirPath = path.join(__dirname, "output");

      // Check if output directory exists
      if (!fs.existsSync(outDirPath)) {
        throw new Error(`Output directory not found at: ${outDirPath}`);
      }

      // --- Added: Set NEXT_PUBLIC_ variables in process.env for Next.js build ---
      for (const [key, value] of Object.entries(envVars)) {
        if (key.startsWith("NEXT_PUBLIC_")) {
          process.env[key] = value;
          publishLog(`Set NEXT_PUBLIC_ environment variable: ${key}`);
        }
      }
      // --- End Added ---

      // Create a promise to handle the build process
      const buildProcess = new Promise((resolve, reject) => {
        // Check if yarn.lock exists to determine package manager
        const yarnLockPath = path.join(outDirPath, "yarn.lock");
        const useYarn = fs.existsSync(yarnLockPath);
        const packageManager = useYarn ? "yarn" : "npm";
        const installCmd = useYarn ? "yarn" : "npm install";
        const globalInstallCmd = useYarn
          ? "yarn global add wrangler"
          : "npm i wrangler -g";
        const devInstallCmd = useYarn
          ? "yarn add @cloudflare/next-on-pages"
          : "npm install --save-dev @cloudflare/next-on-pages";
        const buildCmd = useYarn ? "yarn next-on-pages" : "npx next-on-pages";
        const lockFileToDelete = useYarn ? "package-lock.json" : "yarn.lock";

        // Log the package manager being used
        publishLog(`Using package manager: ${packageManager}`);

        const command = `cd ${outDirPath} && rm -rf node_modules && rm -f ${lockFileToDelete} && ${installCmd} && ${globalInstallCmd} && ${devInstallCmd} && ${buildCmd}`;

        const p = exec(command);

        p.stdout.on("data", function (data) {
          console.log(data.toString());
          publishLog(data.toString());
        });

        p.stderr.on("data", function (data) {
          console.error(data.toString());
          publishLog(`error: ${data.toString()}`);
        });

        p.on("error", function (err) {
          console.error(`Process error: ${err.message}`);
          publishLog(`error: Process error: ${err.message}`);
          reject(err);
        });

        p.on("close", function (code) {
          console.log(`Build process exited with code ${code}`);
          if (code === 0) {
            console.log("Build Complete");
            publishLog(`Build Complete`);
            resolve();
          } else {
            console.error(`Build failed with exit code ${code}`);
            publishLog(`Build failed with exit code ${code}`);
            reject(new Error(`Build failed with exit code ${code}`));
          }
        });
      });

      // Wait for build process to complete
      await buildProcess;

      publishLog(`Preparing Cloudflare Pages Deployment`);

      // Set Cloudflare Pages project configuration
      const cloudflareConfig = `
# Project name for Cloudflare Pages
name = "${PROJECT_ID}"
pages_build_output_dir = "${outDirPath}/.vercel/output/static"

# Required compatibility settings
compatibility_date = "2023-09-04"
compatibility_flags = ["nodejs_compat"]
`;

      try {
        const outputDirContents = fs.readdirSync(outDirPath, {
          recursive: true,
        });
        publishLog(
          `Files in output directory: ${JSON.stringify(
            outputDirContents,
            null,
            2
          )}`
        );
      } catch (err) {
        publishLog(`Warning: Could not read output directory: ${err.message}`);
      }

      // Write out the Cloudflare Pages config
      fs.writeFileSync(
        path.join(outDirPath, "wrangler.toml"),
        cloudflareConfig
      );

      // --- Removed: Secret-setting loop, as NEXT_PUBLIC_ variables don't need to be secrets ---
      // Previously, this loop caused errors with invalid 'wrangler pages secret put' command
      // --- End Removed ---

      publishLog(`Cloudflare Pages Deployment Config Generated`);
      console.log(
        "Preparing for Cloudflare Pages upload...",
        fs.readdirSync(outDirPath)
      );

      // Authenticate using the Cloudflare API token
      if (!CLOUDFLARE_API_TOKEN) {
        throw new Error("CLOUDFLARE_API_TOKEN environment variable is not set");
      }

      // Execute Cloudflare deployments synchronously to ensure completion
      try {
        console.log("Logging in to Cloudflare...");
        execSync(
          `cd ${outDirPath} && export CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN} && wrangler login`,
          { stdio: "inherit" }
        );

        // Attempt to create the project, if it fails, continue to deploy
        try {
          console.log(`Creating Cloudflare Pages project: ${PROJECT_NAME}`);
          execSync(
            `cd ${outDirPath} && wrangler pages project create ${PROJECT_NAME} --production-branch=main`,
            { stdio: "inherit" }
          );
          console.log(`Project '${PROJECT_NAME}' created successfully.`);
          publishLog(`Project '${PROJECT_NAME}' created successfully.`);
        } catch (createError) {
          console.log(
            `Project creation failed (likely already exists): ${createError.message}`
          );
          publishLog(`Project creation failed: ${createError.message}`);
        }

        // Proceed with deployment
        console.log("Starting Cloudflare Pages deployment...");
        publishLog(`Deployment Started for ${PROJECT_NAME}`);

        execSync(
          `cd ${outDirPath} && wrangler pages deploy --branch=main --commit-dirty=true`,
          { stdio: "inherit" }
        );

        console.log("Cloudflare Pages deployment completed successfully");
        publishLog(`Deployment completed successfully`);

        // Ensure all Redis messages are sent before disconnecting
        await new Promise((resolve) => setTimeout(resolve, 1000));

        console.log("All operations completed successfully.");
        process.exit(0);
      } catch (deployError) {
        console.error(`Deployment failed: ${deployError.message}`);
        publishLog(`Deployment failed: ${deployError.message}`);
        publisher.disconnect();
        process.exit(1);
      }
    } catch (error) {
      console.error(`Initialization error: ${error.message}`);
      publishLog(`Initialization error: ${error.message}`);
      publisher.disconnect();
      process.exit(1);
    }
  }

  // Handle process signals
  process.on("SIGINT", () => cleanup("Process interrupted", 130));
  process.on("SIGTERM", () => cleanup("Process terminated", 143));
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    cleanup(`Uncaught exception: ${err.message}`, 1);
  });

  init();
} else {
  function formatEnv(envObj) {
    return Object.entries(envObj)
      .map(([key, val]) => {
        if (typeof val === "string" && /[\s"'`]/.test(val)) {
          val = `"${val.replace(/"/g, '\\"')}"`;
        }
        return `${key}=${val}`;
      })
      .join("\n");
  }
  const env = formatEnv(JSON.parse(process.env.ENVVARS));
  const s3 = new S3Client({
    region: AWS_REGION,
    credentials: process.env.CREDENTIALS,
  });
  const lambda = new LambdaClient({
    region: AWS_REGION,
    credentials: process.env.CREDENTIALS,
  });
  const apiGateway = new APIGatewayClient({
    region: AWS_REGION,
    credentials: process.env.CREDENTIALS,
  });
  const sts = new STSClient({
    region: AWS_REGION,
    credentials: process.env.CREDENTIALS,
  });

  async function zipDir(srcDirs, outPath, excludeNodeModules = false) {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);
    return new Promise((res, rej) => {
      srcDirs.forEach(({ src, dest }) => {
        if (excludeNodeModules) {
          archive.glob(
            "**/*",
            {
              cwd: src,
              ignore: ["node_modules/**"],
              dot: true,
            },
            dest ? { prefix: dest } : {}
          );
        } else {
          archive.directory(src, dest || false, { dot: true });
        }
      });
      archive.on("error", rej).pipe(stream);
      stream.on("close", res);
      archive.finalize();
    });
  }

  async function upload(filePath, key) {
    const body = fs.createReadStream(filePath);
    await s3.send(
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body })
    );
    console.log(`Uploaded ${key} to s3://${S3_BUCKET}/${key}`);
  }

  function detectModuleSystem(outDirPath, serverPath) {
    const packageJsonPath = path.join(outDirPath, "package.json");
    let isESM = false;
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.type === "module") isESM = true;
    }
    if (!isESM && fs.existsSync(serverPath)) {
      const serverContent = fs.readFileSync(serverPath, "utf8");
      if (
        serverContent.includes("import ") ||
        serverContent.includes("export ")
      )
        isESM = true;
    }
    return isESM;
  }

  function modifyServerFile(serverPath) {
    let content = fs.readFileSync(serverPath, "utf8");
    const listenRegex =
      /app\.listen\s*\([^)]*\)\s*{([^{}]*({[^{}]*})*[^}]*)*}\s*;?/gs;
    content = content.replace(listenRegex, "");
    const isESM = content.includes("import ") || content.includes("export ");
    if (isESM) {
      if (!content.includes("export default app")) {
        content = content.replace(/module\.exports\s*=\s*app\s*;?/, "");
        content = content.trim() + "\n\nexport default app;";
      }
    } else {
      if (!content.includes("module.exports = app")) {
        content = content.replace(/export default app\s*;?/, "");
        content = content.trim() + "\n\nmodule.exports = app;";
      }
    }
    fs.writeFileSync(serverPath, content);
    console.log(
      `Modified ${path.basename(
        serverPath
      )} to remove app.listen and ensure proper export`
    );
  }

  async function init() {
    if (!PROJECT_ID || !AWS_REGION)
      throw new Error("Missing PROJECT_ID or AWS_REGION");

    const outDirPath = path.join(__dirname, "output");
    if (!fs.existsSync(outDirPath))
      throw new Error("Output directory not found");

    // Step 1: Find root file and determine if TypeScript
    const possibleServerFiles = [
      path.join(outDirPath, "server.ts"),
      path.join(outDirPath, "server.js"),
      path.join(outDirPath, "src/server.ts"),
      path.join(outDirPath, "src/server.js"),
      path.join(outDirPath, "src/index.ts"),
      path.join(outDirPath, "src/index.js"),
    ];

    let serverPath;
    let isTS = false;
    let rootDir = outDirPath;

    for (const file of possibleServerFiles) {
      if (fs.existsSync(file)) {
        serverPath = file;
        isTS = file.endsWith(".ts");
        if (file.includes("src/")) {
          rootDir = path.join(outDirPath, "src");
        }
        break;
      }
    }

    if (!serverPath) throw new Error("Server or index file not found");

    // Step 2: Create .env file
    const envPath = path.join(outDirPath, ".env");
    fs.writeFileSync(envPath, env);
    console.log(`Created .env file at ${envPath}`);

    // Step 3: Modify root file
    modifyServerFile(serverPath);

    // Step 4: Generate Lambda handler
    const isESM = detectModuleSystem(outDirPath, serverPath);
    const handlerFileName = isTS ? "lambda-handler.ts" : "lambda-handler.js";
    const handlerPath = path.join(rootDir, handlerFileName);
    const relativeServerPath = path
      .relative(rootDir, serverPath)
      .replace(/\\/g, "/")
      .replace(path.extname(serverPath), "");

    let handlerContent;
    if (isTS) {
      if (isESM) {
        handlerContent = `import serverless from 'serverless-http';\nimport app from './${relativeServerPath}';\nexport const handler = serverless(app);`;
      } else {
        handlerContent = `import serverless = require('serverless-http');\nimport app = require('./${relativeServerPath}');\nexport const handler = serverless(app);`;
      }
    } else {
      if (isESM) {
        handlerContent = `import serverless from 'serverless-http';\nimport app from './${relativeServerPath}.js';\nexport const handler = serverless(app);`;
      } else {
        handlerContent = `const serverless = require('serverless-http');\nconst app = require('./${relativeServerPath}');\nexports.handler = serverless(app);`;
      }
    }

    fs.writeFileSync(handlerPath, handlerContent);
    console.log(`Generated ${handlerFileName} in ${rootDir}`);

    // Step 5: Install dependencies
    execSync(
      `cd ${outDirPath} && rm -rf node_modules yarn.lock package-lock.json && npm install && npm i serverless-http`,
      { stdio: "inherit" }
    );

    // Step 6: Handle TS or non-TS workflow
    let zipDirPath = outDirPath;
    if (isTS) {
      // Build TypeScript
      execSync(`npx tsc`, { cwd: outDirPath, stdio: "inherit" });
      zipDirPath = path.join(outDirPath, "dist");
      if (!fs.existsSync(zipDirPath))
        throw new Error("Dist directory not found");

      // Copy essential files to dist (excluding tsconfig.json)
      const essentialFiles = [
        "package.json",
        "package-lock.json",
        ".env",
      ].filter((file) => fs.existsSync(path.join(outDirPath, file)));
      essentialFiles.forEach((file) => {
        fs.copyFileSync(
          path.join(outDirPath, file),
          path.join(zipDirPath, file)
        );
        console.log(`Copied ${file} to ${zipDirPath}`);
      });
    }

    // Step 7: Zip node_modules and upload to S3
    const nodeModulesPath = path.join(outDirPath, "node_modules");
    if (!fs.existsSync(nodeModulesPath))
      throw new Error("node_modules not found");
    const nodeModulesZipPath = path.join(__dirname, "nodejs.zip");
    await zipDir(
      [{ src: nodeModulesPath, dest: "nodejs/node_modules" }],
      nodeModulesZipPath
    );
    await upload(nodeModulesZipPath, `lambdas/${PROJECT_ID}/nodejs.zip`);

    // Step 8: Create Lambda layer
    const layerName = `${PROJECT_ID}-node-modules`;
    const layerResponse = await lambda.send(
      new PublishLayerVersionCommand({
        LayerName: layerName,
        Content: {
          S3Bucket: S3_BUCKET,
          S3Key: `lambdas/${PROJECT_ID}/nodejs.zip`,
        },
        CompatibleRuntimes: ["nodejs20.x"],
        CompatibleArchitectures: ["x86_64"],
      })
    );
    console.log(`Created Lambda layer: ${layerName}`);

    // Step 9: Zip project (without node_modules) and upload to S3
    const projectZipPath = path.join(__dirname, `${PROJECT_ID}.zip`);
    const s3Key = `lambdas/${PROJECT_ID}/${PROJECT_ID}.zip`;
    if (isTS) {
      // Zip dist (compiled files + essential files) without node_modules
      await zipDir([{ src: zipDirPath, dest: false }], projectZipPath);
    } else {
      // Zip output directory excluding node_modules
      await zipDir(
        [{ src: outDirPath, dest: false }],
        projectZipPath,
        true // Exclude node_modules
      );
    }

    if (!fs.existsSync(path.join(zipDirPath, "lambda-handler.js")) && isTS)
      throw new Error("lambda-handler.js not found");
    await upload(projectZipPath, s3Key);

    // Step 10: Create or update Lambda function with layer
    const lambdaParams = {
      FunctionName: PROJECT_ID,
      Handler: `lambda-handler.handler`,
      Runtime: "nodejs20.x",
      Code: { S3Bucket: S3_BUCKET, S3Key: s3Key },
      Role: LAMBDA_ROLE_ARN,
      Timeout: 30,
      MemorySize: 128,
      Architectures: ["x86_64"],
      Layers: [layerResponse.LayerVersionArn],
    };
    let lambdaArn;
    try {
      const createResponse = await lambda.send(
        new CreateFunctionCommand(lambdaParams)
      );
      lambdaArn = createResponse.FunctionArn;
      console.log(`Created Lambda function: ${PROJECT_ID}`);
    } catch (err) {
      if (err.name === "ResourceConflictException") {
        await lambda.send(
          new UpdateFunctionCodeCommand({
            FunctionName: PROJECT_ID,
            S3Bucket: S3_BUCKET,
            S3Key: s3Key,
          })
        );
        // Fetch the Lambda ARN after update
        const lambdaConfig = await lambda.send(
          new GetFunctionCommand({ FunctionName: PROJECT_ID })
        );
        lambdaArn = lambdaConfig.Configuration.FunctionArn;
        console.log(`Updated Lambda function: ${PROJECT_ID}`);
      } else {
        throw err;
      }
    }

    // Step 11: Create or update API Gateway
    const apiName = `${PROJECT_ID}-api`;
    let apiId;
    let rootResourceId;
    let proxyResourceId;

    // Fetch the AWS account ID
    const stsResponse = await sts.send(new GetCallerIdentityCommand({}));
    const accountId = stsResponse.Account;

    // Check if API Gateway already exists
    const existingApis = await apiGateway.send(new GetRestApisCommand({}));
    const existingApi = existingApis.items.find((api) => api.name === apiName);

    if (existingApi) {
      console.log(`API Gateway '${apiName}' already exists. Updating...`);
      apiId = existingApi.id;

      // Get existing resources
      const resources = await apiGateway.send(
        new GetResourcesCommand({ restApiId: apiId })
      );
      const proxyResource = resources.items.find(
        (item) => item.path === "/{proxy+}"
      );
      rootResourceId = resources.items.find((item) => item.path === "/").id;

      // If {proxy+} resource doesn't exist, create it
      if (!proxyResource) {
        const resource = await apiGateway.send(
          new CreateResourceCommand({
            restApiId: apiId,
            parentId: rootResourceId,
            pathPart: "{proxy+}",
          })
        );
        proxyResourceId = resource.id;
      } else {
        proxyResourceId = proxyResource.id;
      }
    } else {
      // Create new API Gateway
      const api = await apiGateway.send(
        new CreateRestApiCommand({ name: apiName })
      );
      apiId = api.id;

      // Get the root resource
      const resources = await apiGateway.send(
        new GetResourcesCommand({ restApiId: apiId })
      );
      rootResourceId = resources.items[0].id;

      // Create the {proxy+} resource
      const resource = await apiGateway.send(
        new CreateResourceCommand({
          restApiId: apiId,
          parentId: rootResourceId,
          pathPart: "{proxy+}",
        })
      );
      proxyResourceId = resource.id;
    }

    // Check and add/update ANY method with Lambda integration
    try {
      await apiGateway.send(
        new GetMethodCommand({
          restApiId: apiId,
          resourceId: proxyResourceId,
          httpMethod: "ANY",
        })
      );
      console.log(
        `ANY method already exists for /{proxy+}. Updating integration...`
      );
    } catch (err) {
      if (err.name === "NotFoundException") {
        await apiGateway.send(
          new PutMethodCommand({
            restApiId: apiId,
            resourceId: proxyResourceId,
            httpMethod: "ANY",
            authorizationType: "NONE",
          })
        );
      } else {
        throw err;
      }
    }
    await apiGateway.send(
      new PutIntegrationCommand({
        restApiId: apiId,
        resourceId: proxyResourceId,
        httpMethod: "ANY",
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        uri: `arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${lambdaArn}/invocations`,
      })
    );

    // Check and add/update OPTIONS method with Mock integration
    try {
      await apiGateway.send(
        new GetMethodCommand({
          restApiId: apiId,
          resourceId: proxyResourceId,
          httpMethod: "OPTIONS",
        })
      );
      console.log(
        `OPTIONS method already exists for /{proxy+}. Updating integration...`
      );
    } catch (err) {
      if (err.name === "NotFoundException") {
        await apiGateway.send(
          new PutMethodCommand({
            restApiId: apiId,
            resourceId: proxyResourceId,
            httpMethod: "OPTIONS",
            authorizationType: "NONE",
          })
        );
      } else {
        throw err;
      }
    }
    await apiGateway.send(
      new PutIntegrationCommand({
        restApiId: apiId,
        resourceId: proxyResourceId,
        httpMethod: "OPTIONS",
        type: "MOCK",
        requestTemplates: {
          "application/json": '{"statusCode": 200}',
        },
      })
    );

    // Add Lambda permission for API Gateway to invoke the Lambda function
    try {
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: PROJECT_ID,
          StatementId: `apigateway-${apiId}`,
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceArn: `arn:aws:execute-api:${AWS_REGION}:${accountId}:${apiId}/*/*`,
        })
      );
    } catch (err) {
      if (err.name !== "ResourceConflictException") {
        throw err; // Ignore if permission already exists
      }
    }

    // Deploy the API to prod stage
    await apiGateway.send(
      new CreateDeploymentCommand({ restApiId: apiId, stageName: "prod" })
    );
    console.log(
      `API Gateway created/updated: https://${apiId}.execute-api.${AWS_REGION}.amazonaws.com/prod`
    );

    process.exit(0);
  }

  init().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
